"""单次本地转写：stdout 仅输出 JSON，依赖和模型日志写入 stderr。"""
import argparse
import contextlib
import importlib
import importlib.metadata
import json
import os
import sys
import time


def transcribe(args):
    os.environ.setdefault("HF_HOME", os.path.join(args.model_dir, "huggingface"))
    os.environ.setdefault("MODELSCOPE_CACHE", os.path.join(args.model_dir, "modelscope"))
    # ModelScope 匿名下载也会保存 session；模型缓存变量不控制这个目录。
    os.environ.setdefault("MODELSCOPE_CREDENTIALS_PATH", os.path.join(args.model_dir, "modelscope-session"))
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    started = time.monotonic()
    if args.provider == "whisper":
        from faster_whisper import WhisperModel
        model = WhisperModel(args.model, device="cpu", compute_type="int8", cpu_threads=4,
                             download_root=args.model_dir)
        iterator, info = model.transcribe(
            args.audio, language=None if args.language == "auto" else args.language,
            beam_size=5, vad_filter=True, condition_on_previous_text=False)
        segments = [{"startMs": round(s.start * 1000), "endMs": round(s.end * 1000),
                     "text": s.text.strip(), "avgLogprob": s.avg_logprob,
                     "noSpeechProbability": s.no_speech_prob} for s in iterator if s.text.strip()]
        language = info.language
    else:
        from funasr import AutoModel
        model = AutoModel(model=args.model, vad_model="fsmn-vad", punc_model="ct-punc",
                          device="cpu", disable_update=True, trust_remote_code=False)
        result = model.generate(input=args.audio, batch_size_s=60, sentence_timestamp=True)
        segments = []
        for record in result:
            sentences = record.get("sentence_info", [])
            if record.get("text", "").strip() and not sentences:
                # 不按字数均分时间，不把无时间戳全文伪装成可定位证据。
                raise ValueError("asr_timestamps_missing")
            for sentence in sentences:
                text = sentence.get("text", sentence.get("sentence", "")).strip()
                if text:
                    segments.append({"startMs": sentence["start"], "endMs": sentence["end"], "text": text})
        language = args.language
    return {"provider": args.provider, "model": args.model, "language": language,
            "segments": segments, "processingSeconds": round(time.monotonic() - started, 3)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--doctor", action="store_true")
    parser.add_argument("--provider", choices=["whisper", "funasr"], default="whisper")
    parser.add_argument("--model", default="small")
    parser.add_argument("--model-dir", default=".data/content-models")
    parser.add_argument("--language", default="zh")
    parser.add_argument("--audio")
    args = parser.parse_args()
    if args.doctor:
        modules = (["torch", "torchaudio", "funasr", "modelscope"]
                   if args.provider == "funasr" else ["faster_whisper"])
        report = {"python": sys.version.split()[0], "provider": args.provider,
                  "ready": False, "versions": {}}
        try:
            with contextlib.redirect_stdout(sys.stderr):
                for module in modules:
                    importlib.import_module(module)
                    report["versions"][module] = importlib.metadata.version(module.replace("_", "-"))
            report["ready"] = True
        except Exception as exc:
            report["error"] = "asr_dependency_unavailable"
            report["errorType"] = type(exc).__name__
        print(json.dumps(report))
        return
    if not args.audio or not os.path.isfile(args.audio):
        print(json.dumps({"error": "local_audio_required"}))
        sys.exit(1)
    try:
        with contextlib.redirect_stdout(sys.stderr):
            result = transcribe(args)
        print(json.dumps(result, ensure_ascii=False, allow_nan=False))
    except Exception as exc:
        code = "asr_dependency_missing" if isinstance(exc, ImportError) else (
            "asr_timestamps_missing" if str(exc) == "asr_timestamps_missing" else "asr_failed")
        # 不将第三方异常中的凭证/下载URL写入任务结果。
        print(json.dumps({"error": code, "errorType": type(exc).__name__}))
        sys.exit(1)


if __name__ == "__main__":
    main()
