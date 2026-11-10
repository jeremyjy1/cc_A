"""Execute one approved text-file operation relative to an open workspace directory."""
import contextlib
import json
import os
import secrets
import stat
import sys

DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
LIMIT = 2 * 1024 * 1024


@contextlib.contextmanager
def parent(root, path, create):
    if not isinstance(path, str) or not path or "\0" in path:
        raise ValueError("invalid path")
    rel = os.path.relpath(path, root) if os.path.isabs(path) else path
    parts = [p for p in rel.split("/") if p not in (".", "")]
    if not parts or any(p == ".." or p.casefold() == ".git" for p in parts):
        raise ValueError("path outside workspace or in .git")
    fd = os.open(root, DIRECTORY)
    try:
        for part in parts[:-1]:
            if create:
                try:
                    os.mkdir(part, 0o755, dir_fd=fd)
                except FileExistsError:
                    pass
            child = os.open(part, DIRECTORY, dir_fd=fd)
            os.close(fd)
            fd = child
        yield fd, parts[-1]
    finally:
        os.close(fd)


def read_text(fd, name):
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
    with os.fdopen(os.open(name, flags, dir_fd=fd), "rb") as file:
        info = os.fstat(file.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > LIMIT:
            raise ValueError("requires a regular workspace file within 2 MiB")
        data = file.read(LIMIT + 1)
        if len(data) > LIMIT or b"\0" in data:
            raise ValueError("requires a UTF-8 text file within 2 MiB")
        return data.decode(), info


def execute(root, tool, args):
    with parent(root, args["file_path"], tool == "Write") as (fd, name):
        try:
            original, info = read_text(fd, name)
        except FileNotFoundError:
            if tool != "Write":
                raise
            original, info = "", None
        if tool == "Read":
            if args.get("pages"):
                raise ValueError("PDF pages unsupported")
            start, limit = args.get("offset", 1), args.get("limit", 2000)
            if not isinstance(start, int) or not isinstance(limit, int) or min(start, limit) < 1:
                raise ValueError("invalid line range")
            lines = original.splitlines()[start - 1:start - 1 + limit]
            return "\n".join(f"{i}\t{line}" for i, line in enumerate(lines, start))
        if tool == "Edit":
            old, new = args["old_string"], args["new_string"]
            if not old or old not in original or (not args.get("replace_all") and original.count(old) != 1):
                raise ValueError("old_string must match; ambiguous match requires replace_all")
            content = original.replace(old, new, -1 if args.get("replace_all") else 1)
        elif tool == "Write":
            content = args["content"]
        else:
            raise ValueError("unsupported file tool")
        tmp = ".cc-a-" + secrets.token_hex(12)
        with os.fdopen(os.open(tmp, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600, dir_fd=fd), "wb") as out:
            try:
                out.write(content.encode())
                out.flush()
                if info:
                    now = os.stat(name, dir_fd=fd, follow_symlinks=False)
                    if (now.st_ino, now.st_mtime_ns) != (info.st_ino, info.st_mtime_ns):
                        raise ValueError("file changed during operation")
                    os.fchmod(out.fileno(), stat.S_IMODE(info.st_mode) & 0o777)
                    os.replace(tmp, name, src_dir_fd=fd, dst_dir_fd=fd)
                else:
                    os.link(tmp, name, src_dir_fd=fd, dst_dir_fd=fd, follow_symlinks=False)
            finally:
                try:
                    os.unlink(tmp, dir_fd=fd)
                except FileNotFoundError:
                    pass
        return "ok"


if __name__ == "__main__":
    try:
        print(execute(os.getcwd(), sys.argv[1], json.load(sys.stdin)), end="")
    except (KeyError, OSError, UnicodeError, TypeError, ValueError) as exc:
        sys.exit(str(exc))
