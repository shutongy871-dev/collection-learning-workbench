"""在本机终端隐藏输入凭证，仅保存到项目的私有配置文件。"""
import getpass
import os
from pathlib import Path
import re
import sys
import tempfile
from urllib import request


def main():
    if not sys.stdin.isatty():
        raise ValueError("请在自己的交互式终端运行，不要通过命令参数或聊天传递密钥。")
    root = Path(__file__).resolve().parent.parent
    target = root / ".env.content"
    if target.is_symlink():
        raise ValueError(".env.content 不能是符号链接。")
    source = target if target.exists() else root / ".env.content.example"
    original = source.read_text(encoding="utf-8")
    key = getpass.getpass("粘贴百炼北京地域 API Key（输入不显示，回车保存）：").strip()
    if not re.fullmatch(r"[A-Za-z0-9_.-]{16,512}", key):
        raise ValueError("密钥为空或格式异常，未修改配置。")
    lines = [line for line in original.splitlines()
             if not re.match(r"^\s*(?:export\s+)?CONTENT_VISION_API_KEY\s*=", line)]
    lines.append("CONTENT_VISION_API_KEY=" + key)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=root,
                                         prefix=".content-key-", delete=False) as handle:
            temporary = handle.name
            os.chmod(temporary, 0o600)
            handle.write("\n".join(lines) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, target)
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)
    print("已保存到 .env.content（权限 600），未发起模型调用。")
    try:
        resume = request.Request("http://127.0.0.1:7790/api/batch/run",
                                 data=b'{"retry":true}',
                                 headers={"Content-Type": "application/json"},
                                 method="POST")
        with request.urlopen(resume, timeout=2):
            pass
        print("学习工作台已收到配置，将在后台自动生成今日题目。")
    except Exception:
        print("学习工作台未运行；下次启动时会自动生成今日题目。")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError) as exc:
        print(str(exc) if isinstance(exc, ValueError) else "配置文件写入失败，未输出凭证。", file=sys.stderr)
        sys.exit(1)
    except (KeyboardInterrupt, EOFError):
        print("\n已取消，未修改配置。", file=sys.stderr)
        sys.exit(1)
