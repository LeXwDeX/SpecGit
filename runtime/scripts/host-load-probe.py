"""Probe real host loading of SpecGit skills, guidance and hook context.

Each selected host runs one non-interactive session in an isolated temporary
project. Host configuration, model transports and state stay inside that
temporary directory. Model calls use loopback-only synthetic servers; no user
credentials or remote model are used.

A host is `pass` only when the installed host itself shows the Skill, the
project guidance and, where the host supports them, SessionStart/PreToolUse
context. A missing host is `not-installed`, never `pass`. Codex project hooks
need the host's own trust review; this probe reports that limitation instead
of automating trust.
"""
import argparse
import hashlib
import http.server
import json
import os
import re
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

SCHEMA_VERSION = 1
BODY_LIMIT = 4_194_304
OUTPUT_LIMIT = 8_388_608
EVIDENCE_LIMIT = 2_097_152
HOSTS = ("claude", "codex", "opencode")
SKILL_NAME = "specgit-native"
SESSION_RULE = "never use --no-verify"
SESSION_MARKER = "Read project `.agents/skills/specgit-native/SKILL.md`"
GUIDANCE_MARKER = "Read project-root `.agents/skills/specgit-native/SKILL.md`"
RECOVERY_MARKER = "SpecGit retains an uncertain native write"

PASS = "pass"
FAIL = "fail"
NOT_CHECKED = "not-checked"
NOT_SUPPORTED = "not-supported"


def checked(status, detail):
    return {"status": status, "detail": detail}


def bounded_text(value, limit=2000):
    text = value if isinstance(value, str) else str(value)
    if len(text) > limit:
        return text[:limit] + "...[truncated]"
    return text


def read_bounded(path, limit=OUTPUT_LIMIT):
    try:
        with open(path, "rb") as handle:
            return handle.read(limit).decode("utf8", "replace")
    except OSError:
        return ""


def write_private(path, text):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as handle:
        handle.write(text.encode("utf8"))


def free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def run_bounded(argv, cwd, env, timeout, stdout_path=None, stderr_path=None, stdin_bytes=None):
    """Run one absolute argv with a bounded wall clock and captured output."""
    tmp = None
    if stdout_path is None or stderr_path is None:
        tmp = tempfile.mkdtemp(prefix="specgit-probe-io-")
        stdout_path = stdout_path or os.path.join(tmp, "stdout")
        stderr_path = stderr_path or os.path.join(tmp, "stderr")
    timed_out = False
    with open(stdout_path, "wb") as out, open(stderr_path, "wb") as err:
        process = subprocess.Popen(
            [str(item) for item in argv],
            cwd=str(cwd),
            env=env,
            stdin=subprocess.PIPE if stdin_bytes is not None else subprocess.DEVNULL,
            stdout=out,
            stderr=err,
            start_new_session=os.name != "nt",
        )
        try:
            process.communicate(input=stdin_bytes, timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            terminate(process)
            try:
                process.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                kill(process)
                process.communicate()
    result = {
        "exit": process.returncode,
        "timed_out": timed_out,
        "stdout": read_bounded(stdout_path),
        "stderr": read_bounded(stderr_path),
    }
    if tmp is not None:
        shutil.rmtree(tmp, ignore_errors=True)
    return result


def terminate(process):
    try:
        if os.name != "nt":
            os.killpg(process.pid, signal.SIGTERM)
        else:
            process.terminate()
    except (ProcessLookupError, PermissionError, OSError):
        pass


def kill(process):
    try:
        if os.name != "nt":
            os.killpg(process.pid, signal.SIGKILL)
        else:
            process.kill()
    except (ProcessLookupError, PermissionError, OSError):
        pass


def stop_process(process, timeout=5):
    if process.poll() is not None:
        return
    terminate(process)
    try:
        process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        kill(process)
        try:
            process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            pass


def resolve_executable(explicit, name):
    if explicit:
        candidate = Path(explicit).expanduser()
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate.resolve())
        return None
    found = shutil.which(name)
    return str(Path(found).resolve()) if found else None


def base_environment(root, project, extra_path=()):
    keep = ["PATH", "USER", "LOGNAME", "TMPDIR", "SHELL", "LANG", "LC_ALL", "TERM"]
    if os.name == "nt":
        keep += ["SystemRoot", "ComSpec", "PATHEXT", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]
    env = {key: os.environ[key] for key in keep if key in os.environ}
    path = [str(item) for item in extra_path] + [env.get("PATH", "")]
    env["PATH"] = os.pathsep.join(item for item in path if item)
    env.update({
        "HOME": os.path.join(root, "home"),
        "PWD": str(project),
        "XDG_CONFIG_HOME": os.path.join(root, "xdg", "config"),
        "XDG_DATA_HOME": os.path.join(root, "xdg", "data"),
        "XDG_CACHE_HOME": os.path.join(root, "xdg", "cache"),
        "XDG_STATE_HOME": os.path.join(root, "xdg", "state"),
        "NO_PROXY": "127.0.0.1,localhost",
        "no_proxy": "127.0.0.1,localhost",
        "HTTP_PROXY": "",
        "HTTPS_PROXY": "",
        "ALL_PROXY": "",
        "http_proxy": "",
        "https_proxy": "",
        "all_proxy": "",
    })
    for key in ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]:
        env.pop(key, None)
    return env


def prepare_dirs(root):
    for relative in ("home", "xdg/config", "xdg/data", "xdg/cache", "xdg/state"):
        os.makedirs(os.path.join(root, relative), exist_ok=True)


def git_fixture(root, project):
    git = shutil.which("git")
    if not git:
        raise RuntimeError("git is required to create the isolated project")
    git = str(Path(git).resolve())
    env = base_environment(root, project)
    env["GIT_CONFIG_NOSYSTEM"] = "1"
    commands = [
        [git, "init", "-b", "fixture"],
        [git, "config", "user.name", "Fixture"],
        [git, "config", "user.email", "fixture@example.invalid"],
        [git, "remote", "add", "origin", "https://github.com/fixture/context.git"],
    ]
    for command in commands:
        result = run_bounded(command, cwd=project, env=env, timeout=20)
        if result["exit"] != 0:
            raise RuntimeError("fixture git command failed: " + bounded_text(result["stderr"], 500))
    Path(project, "README.md").write_text("Synthetic host fixture.\n", encoding="utf8")
    Path(project, ".specgit.yaml").write_text("version: 2\nprovider: github\nremote: origin\nlanguage: en\n", encoding="utf8")
    for command in ([git, "add", "."], [git, "commit", "-m", "fixture"]):
        result = run_bounded(command, cwd=project, env=env, timeout=20)
        if result["exit"] != 0:
            raise RuntimeError("fixture git command failed: " + bounded_text(result["stderr"], 500))


def fake_gh(bindir):
    """Record a real product checkpoint with an unresolved native write.

    The fixture transport fails after SpecGit records write_started, which is the
    documented local state PreToolUse recovery is built from. No platform
    credentials or network are used.
    """
    posix = os.path.join(bindir, "gh")
    script = """#!/bin/sh
case "$*" in
  *"--method POST"*) echo 'fixture transport failure' >&2; exit 1 ;;
  *"repos/fixture/context/labels"*) echo '[]' ;;
  *"search/issues"*) echo '{"incomplete_results":false,"total_count":0,"items":[]}' ;;
  *"repos/fixture/context/issues?"*) echo '[]' ;;
  *"repos/fixture/context"*) echo '{"id":12345,"full_name":"fixture/context","default_branch":"main"}' ;;
  *) echo '{}' ;;
esac
"""
    with open(posix, "w", encoding="utf8") as handle:
        handle.write(script)
    os.chmod(posix, 0o755)


def seed_pending_write(binary, project, env):
    result = run_bounded(
        [binary, "issue", "fix: host load probe pending write", "--json"],
        cwd=project,
        env=env,
        timeout=45,
    )
    selection = Path(project, ".git", "specgit-v2", "selection.json")
    if not selection.is_file():
        return False, "checkpoint was not written: " + bounded_text(result["stderr"] or result["stdout"], 600)
    try:
        payload = json.loads(read_bounded(selection, 1_048_576) or "{}")
    except ValueError:
        return False, "checkpoint is not valid JSON"
    pending = any(
        intent.get("write_started") is True and intent.get("issue") is None
        for intent in payload.get("intents", [])
    )
    if not pending:
        return False, "checkpoint has no unresolved write intent"
    return True, "recorded an unresolved native write through the product CLI"


def setup_project(binary, host, project, root):
    env = base_environment(root, project, extra_path=[os.path.dirname(binary)])
    argv = [binary, "setup", "--agent", host, "--hook-purpose", "context", "--json"]
    if host == "opencode":
        argv.insert(-1, "--opencode-claude-hooks")
    result = run_bounded(argv, cwd=project, env=env, timeout=45)
    report = {}
    try:
        report = json.loads(result["stdout"])
    except ValueError:
        pass
    evidence = report.get("evidence", {})
    installed = evidence.get("hook_purposes", {}).get(host, {}).get("installed", [])
    declined = evidence.get("hook_purposes", {}).get(host, {}).get("declined", [])
    hooks_supported = "context" in installed
    if report.get("status") != "installed":
        raise RuntimeError(
            "setup did not install project assets: "
            + bounded_text(result["stderr"] or result["stdout"], 800)
        )
    return {
        "supported": hooks_supported,
        "declined": declined,
        "assets": [item.get("path") for item in evidence.get("assets", [])],
        "env": env,
        "stdout": bounded_text(result["stdout"], 1000),
    }


def version_of(binary, root, project, timeout=20):
    env = base_environment(root, project)
    result = run_bounded([binary, "--version"], cwd=project, env=env, timeout=timeout)
    return bounded_text((result["stdout"] or result["stderr"]).strip(), 200), result["exit"]


def specgit_version(binary, root, timeout=20):
    env = base_environment(root, root)
    result = run_bounded([binary, "--human", "--version"], cwd=root, env=env, timeout=timeout)
    text = (result["stdout"] or result["stderr"]).strip()
    if text.startswith("{"):
        try:
            payload = json.loads(text)
            text = payload.get("version") or payload.get("evidence", {}).get("text", text)
        except ValueError:
            pass
    return bounded_text(str(text).strip(), 200)


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1_048_576), b""):
            digest.update(block)
    return digest.hexdigest()


def read_settings(root, project, relative):
    path = Path(project, relative)
    if not path.is_file():
        return None
    try:
        return json.loads(read_bounded(path, 1_048_576))
    except ValueError:
        return None


def parse_opencode_hooks(log_path):
    text = read_bounded(log_path, EVIDENCE_LIMIT)
    events = {}
    for match in re.finditer(
        r"message=hook close command=.*?hook --event (\w+).*?exitCode=(-?\d+) stdoutLen=(\d+)",
        text,
    ):
        event, code, length = match.group(1), int(match.group(2)), int(match.group(3))
        events.setdefault(event, []).append({"exit": code, "stdout": length})
    loaded = re.search(r"message=\"?loaded hook settings path=(.+?) events=(\[[^\]]*\])", text)
    return {
        "events": events,
        "loaded_path": loaded.group(1) if loaded else None,
        "loaded_events": loaded.group(2) if loaded else None,
        "log": text,
    }


def hook_summary(events, name):
    runs = events.get(name, [])
    return bool(runs) and all(run["exit"] == 0 for run in runs) and any(run["stdout"] > 0 for run in runs)


class BoundedHandler(http.server.BaseHTTPRequestHandler):
    server_version = "SpecGitHostProbe/1"
    requests = None
    request_path = None

    def log_message(self, *_args):
        pass

    def read_json(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length < 0 or length > BODY_LIMIT:
            self.send_error(413)
            return None
        raw = self.rfile.read(length)
        try:
            return json.loads(raw or b"{}")
        except ValueError:
            return {}

    def record(self, path, body):
        if self.requests is not None:
            self.requests.append({"path": path, "body": body})
            if self.request_path:
                write_private(self.request_path, json.dumps(self.requests, ensure_ascii=False))

    def send_json(self, payload):
        data = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def send_events(self, events):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        for name, data in events:
            self.wfile.write(("event: " + name + "\ndata: " + json.dumps(data) + "\n\n").encode())
            self.wfile.flush()


def anthropic_message(model, content, stop_reason):
    return {
        "id": "msg_local_fixture",
        "type": "message",
        "role": "assistant",
        "model": model,
        "content": content,
        "stop_reason": stop_reason,
        "stop_sequence": None,
        "usage": {"input_tokens": 100, "output_tokens": 8},
    }


class AnthropicHandler(BoundedHandler):
    seed = None
    model = "claude-sonnet-4-6"
    conversation = []

    def do_GET(self):
        self.send_json({})

    def do_POST(self):
        body = self.read_json()
        if body is None:
            return
        if "count_tokens" in self.path:
            self.send_json({"input_tokens": 100})
            return
        if not self.path.startswith("/v1/messages"):
            self.send_json({})
            return
        self.record(self.path, body)
        self.conversation.append(body)
        round_number = len(self.conversation)
        if round_number == 1:
            if type(self).seed is not None:
                type(self).seed()
            tool_input = {"command": "sleep 1"}
            content = [
                {"type": "text", "text": "Running the fixture tool."},
                {"type": "tool_use", "id": "tool_local_fixture", "name": "Bash", "input": tool_input},
            ]
            stop_reason = "tool_use"
        else:
            content = [{"type": "text", "text": "done"}]
            stop_reason = "end_turn"
        message = anthropic_message(self.model, content, stop_reason)
        if not body.get("stream"):
            self.send_json(message)
            return
        events = [
            ("message_start", {"type": "message_start", "message": {**message, "content": []}}),
            ("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
            ("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": content[0]["text"]}}),
            ("content_block_stop", {"type": "content_block_stop", "index": 0}),
        ]
        if stop_reason == "tool_use":
            events += [
                ("content_block_start", {"type": "content_block_start", "index": 1, "content_block": {"type": "tool_use", "id": "tool_local_fixture", "name": "Bash", "input": {}}}),
                ("content_block_delta", {"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": json.dumps(tool_input)}}),
                ("content_block_stop", {"type": "content_block_stop", "index": 1}),
            ]
        events += [
            ("message_delta", {"type": "message_delta", "delta": {"stop_reason": stop_reason, "stop_sequence": None}, "usage": {"output_tokens": 8}}),
            ("message_stop", {"type": "message_stop"}),
        ]
        self.send_events(events)


class OpenAiHandler(BoundedHandler):
    """Small Responses/Completions fixture for Codex and OpenCode."""

    def do_GET(self):
        self.send_json({"object": "list", "data": [{"id": "fixture-model", "object": "model"}]})

    def do_POST(self):
        body = self.read_json()
        if body is None:
            return
        self.record(self.path, body)
        if self.path.endswith("/responses"):
            self.responses_stream()
        elif self.path.endswith("/chat/completions"):
            self.chat()
        else:
            self.send_json({})

    def responses_stream(self):
        response_id = "resp_fixture"
        message_id = "msg_fixture"
        response = {
            "id": response_id,
            "object": "response",
            "created_at": int(time.time()),
            "status": "in_progress",
            "model": "fixture-model",
            "output": [],
        }
        item = {"id": message_id, "type": "message", "status": "in_progress", "role": "assistant", "content": []}
        events = [
            ("response.created", {"type": "response.created", "response": response}),
            ("response.output_item.added", {"type": "response.output_item.added", "output_index": 0, "item": item}),
            ("response.content_part.added", {"type": "response.content_part.added", "item_id": message_id, "output_index": 0, "content_index": 0, "part": {"type": "output_text", "text": "", "annotations": []}}),
            ("response.output_text.delta", {"type": "response.output_text.delta", "item_id": message_id, "output_index": 0, "content_index": 0, "delta": "ok"}),
            ("response.output_text.done", {"type": "response.output_text.done", "item_id": message_id, "output_index": 0, "content_index": 0, "text": "ok"}),
            ("response.output_item.done", {"type": "response.output_item.done", "output_index": 0, "item": {"id": message_id, "type": "message", "status": "completed", "role": "assistant", "content": [{"type": "output_text", "text": "ok", "annotations": []}]}}),
        ]
        self.send_events(events)
        completed = {
            "type": "response.completed",
            "response": {
                "id": response_id,
                "object": "response",
                "status": "completed",
                "model": "fixture-model",
                "output": [{"id": message_id, "type": "message", "status": "completed", "role": "assistant", "content": [{"type": "output_text", "text": "ok", "annotations": []}]}],
                "usage": {"input_tokens": 10, "input_tokens_details": {"cached_tokens": 0}, "output_tokens": 1, "output_tokens_details": {"reasoning_tokens": 0}, "total_tokens": 11},
            },
        }
        self.wfile.write(("event: response.completed\ndata: " + json.dumps(completed) + "\n\n").encode())
        self.wfile.flush()

    def chat(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        chunk = {
            "id": "chatcmpl_fixture",
            "object": "chat.completion.chunk",
            "created": 0,
            "model": "fixture-model",
            "choices": [{"index": 0, "delta": {"role": "assistant", "content": "ok"}, "finish_reason": None}],
        }
        done = {
            "id": "chatcmpl_fixture",
            "object": "chat.completion.chunk",
            "created": 0,
            "model": "fixture-model",
            "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
        }
        self.wfile.write(b"data: " + json.dumps(chunk).encode() + b"\n\n")
        self.wfile.write(b"data: " + json.dumps(done).encode() + b"\n\ndata: [DONE]\n\n")
        self.wfile.flush()


class FixtureServer:
    def __init__(self, handler, request_path):
        self.requests = []
        handler.requests = self.requests
        handler.request_path = request_path
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    @property
    def endpoint(self):
        return "http://127.0.0.1:" + str(self.server.server_port)

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def api_request(base, method, path, body=None, timeout=15):
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(
        base + path,
        data=data,
        method=method,
        headers={"Content-Type": "application/json"},
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(request, timeout=timeout) as response:
            return response.status, response.read(BODY_LIMIT).decode("utf8", "replace")
    except urllib.error.HTTPError as error:
        return error.code, error.read(BODY_LIMIT).decode("utf8", "replace")
    except Exception as error:  # noqa: BLE001 - report transport facts, never fabricate a pass
        return None, bounded_text(repr(error), 500)


def wait_until(predicate, timeout, interval=0.2):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return False


def request_text(request):
    return json.dumps(request.get("body", {}), ensure_ascii=False)


def first_request(requests):
    return requests[0] if requests else None


def host_report(version):
    return {
        "status": FAIL,
        "version": version,
        "checks": {},
        "notes": [],
        "evidence": {},
    }


def finalize(report):
    failures = []
    for name, check in report["checks"].items():
        if check["status"] in (FAIL, NOT_CHECKED):
            failures.append(name + ": " + check["status"])
    report["status"] = PASS if not failures else FAIL
    if failures:
        report["notes"].append("Not passed: " + ", ".join(failures))
    return report


def cleanup_root(root, keep):
    if keep:
        return str(root)
    shutil.rmtree(root, ignore_errors=True)
    return None


def probe_claude(binary, executable, args, root):
    report = host_report(None)
    if not executable:
        report["status"] = "not-installed"
        report["notes"].append("Claude Code CLI not found on PATH; pass --claude /absolute/path to probe it.")
        return report
    version, _ = version_of(executable, root, root)
    report["version"] = version
    project = os.path.join(root, "project")
    os.makedirs(project, exist_ok=True)
    prepare_dirs(root)
    bindir = os.path.join(root, "bin")
    os.makedirs(bindir, exist_ok=True)
    fake_gh(bindir)
    fixture = None
    try:
        git_fixture(root, project)
        setup = setup_project(binary, "claude", project, root)
        setup["env"]["PATH"] = bindir + os.pathsep + setup["env"]["PATH"]
        settings = read_settings(root, project, ".claude/settings.json")
        hooks_written = bool((settings or {}).get("hooks"))
        report["evidence"]["setup_assets"] = setup["assets"]
        if not hooks_written:
            report["checks"]["session_start"] = checked(FAIL, "setup did not write SessionStart/PreToolUse hooks")
            report["checks"]["pretool_context"] = checked(FAIL, "setup did not write SessionStart/PreToolUse hooks")
            report["checks"]["skill"] = checked(FAIL, "setup did not write project Skill assets")
            report["checks"]["guidance"] = checked(FAIL, "setup did not write project guidance")
            return finalize(report)
        config = os.path.join(root, "claude")
        os.makedirs(config, exist_ok=True)
        fixture = FixtureServer(AnthropicHandler, os.path.join(root, "model-requests.json"))
        seed_state = {}

        def seed():
            if seed_state:
                return
            seed_state["result"] = seed_pending_write(binary, project, setup["env"])

        AnthropicHandler.seed = seed
        AnthropicHandler.conversation = []
        Path(root, "mcp.json").write_text('{"mcpServers":{}}', encoding="utf8")
        env = setup["env"]
        env.update({
            "CLAUDE_CONFIG_DIR": config,
            "ANTHROPIC_API_KEY": "sk-ant-fixture-not-a-real-key",
            "ANTHROPIC_BASE_URL": fixture.endpoint,
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
            "CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL": "1",
            "HTTP_PROXY": fixture.endpoint,
            "HTTPS_PROXY": fixture.endpoint,
            "ALL_PROXY": fixture.endpoint,
        })
        stdout_path = os.path.join(root, "host.jsonl")
        stderr_path = os.path.join(root, "host.stderr")
        argv = [
            executable, "-p", "--setting-sources", "project", "--model", "sonnet",
            "--tools", "Bash", "--allowedTools", "Bash(sleep *)",
            "--strict-mcp-config", "--mcp-config", os.path.join(root, "mcp.json"),
            "--no-session-persistence", "--output-format", "stream-json",
            "--include-hook-events", "--verbose",
            "Reply with the SpecGit context identifier.",
        ]
        result = run_bounded(
            argv, cwd=project, env=env, timeout=args.timeout,
            stdout_path=stdout_path, stderr_path=stderr_path,
        )
        report["evidence"]["host_exit"] = result["exit"]
        report["evidence"]["timed_out"] = result["timed_out"]
        report["checks"]["session_exit"] = checked(
            PASS if result["exit"] == 0 and not result["timed_out"] else FAIL,
            "host session exited zero" if result["exit"] == 0 and not result["timed_out"] else "host session exit=%s timed_out=%s" % (result["exit"], result["timed_out"]),
        )
        report["evidence"]["hook_events"] = []
        skills = []
        hook_events = []
        for line in read_bounded(stdout_path).splitlines():
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if event.get("subtype") == "init":
                skills = event.get("skills", [])
            if event.get("subtype") in ("hook_started", "hook_response"):
                hook_events.append({key: event.get(key) for key in ("subtype", "hook_name", "hook_event", "outcome", "exit_code")})
        report["evidence"]["hook_events"] = hook_events[:20]
        requests = fixture.requests
        first = first_request(requests)
        first_text = request_text(first) if first else ""
        later_text = "\n".join(request_text(item) for item in requests[1:])
        report["evidence"]["model_requests"] = len([item for item in requests if item.get("path", "").startswith("/v1/messages")])
        report["checks"]["skill"] = checked(
            PASS if SKILL_NAME in skills else FAIL,
            "host init listed " + SKILL_NAME if SKILL_NAME in skills else "host init did not list " + SKILL_NAME,
        )
        guidance = GUIDANCE_MARKER in first_text and "project instructions" in first_text
        report["checks"]["guidance"] = checked(
            PASS if guidance else FAIL,
            "CLAUDE.md project instructions reached the model transport" if guidance else "CLAUDE.md project instructions were not observed in the first model request",
        )
        session_hook = any(
            event.get("hook_event") == "SessionStart"
            and event.get("subtype") == "hook_response"
            and event.get("exit_code") == 0
            for event in hook_events
        )
        session_context = SESSION_RULE in first_text
        report["checks"]["session_start"] = checked(
            PASS if session_hook and session_context else FAIL,
            "SessionStart hook succeeded and its rules reached the model request"
            if session_hook and session_context
            else "SessionStart hook success=%s, context in first model request=%s" % (session_hook, session_context),
        )
        pretool_hook = any(
            event.get("hook_event") == "PreToolUse"
            and event.get("subtype") == "hook_response"
            and event.get("exit_code") == 0
            for event in hook_events
        )
        pretool_context = RECOVERY_MARKER in later_text
        seed_ok, seed_detail = seed_state.get("result", (False, "pending write was not seeded"))
        report["evidence"]["pending_write"] = seed_detail
        report["checks"]["pretool_context"] = checked(
            PASS if pretool_hook and pretool_context and seed_ok else FAIL,
            "PreToolUse hook delivered recovery context on the next model request"
            if pretool_hook and pretool_context and seed_ok
            else "PreToolUse hook success=%s, recovery context in later request=%s, seed=%s"
            % (pretool_hook, pretool_context, seed_detail),
        )
        return finalize(report)
    except Exception as error:  # noqa: BLE001 - one host failure must not hide another host
        report["status"] = FAIL
        report["notes"].append("probe error: " + bounded_text(repr(error), 800))
        return report
    finally:
        if fixture is not None:
            fixture.close()


def probe_opencode(binary, executable, args, root):
    report = host_report(None)
    if not executable:
        report["status"] = "not-installed"
        report["notes"].append("OpenCode CLI not found on PATH; pass --opencode /absolute/path to probe it.")
        return report
    version, _ = version_of(executable, root, root)
    report["version"] = version
    project = os.path.join(root, "project")
    os.makedirs(project, exist_ok=True)
    prepare_dirs(root)
    bindir = os.path.join(root, "bin")
    os.makedirs(bindir, exist_ok=True)
    fake_gh(bindir)
    fixture = None
    server_process = None
    try:
        git_fixture(root, project)
        setup = setup_project(binary, "opencode", project, root)
        setup["env"]["PATH"] = bindir + os.pathsep + setup["env"]["PATH"]
        report["evidence"]["setup_assets"] = setup["assets"]
        hooks_supported = setup["supported"]
        if setup["declined"]:
            report["notes"].append("setup declined context hooks: " + bounded_text(setup["declined"], 600))
        env = setup["env"]
        env.update({
            "OPENCODE_DISABLE_MODELS_FETCH": "1",
            "OPENCODE_DISABLE_AUTOUPDATE": "1",
            "OPENCODE_DISABLE_LSP_DOWNLOAD": "1",
            "OPENCODE_DISABLE_PRUNE": "1",
            "OPENCODE_DISABLE_SHARE": "1",
            "OPENCODE_DISABLE_DEFAULT_PLUGINS": "1",
        })
        skill_result = run_bounded(
            [executable, "debug", "skill", "--pure"],
            cwd=project, env=env, timeout=30,
        )
        skills = []
        try:
            skills = json.loads(skill_result["stdout"])
        except ValueError:
            pass
        skill = next((item for item in skills if item.get("name") == SKILL_NAME), None)
        skill_ok = bool(skill and ".agents/skills/specgit-native/SKILL.md" in str(skill.get("location", "")))
        report["evidence"]["skill_location"] = skill.get("location") if skill else None
        report["checks"]["skill"] = checked(
            PASS if skill_ok else FAIL,
            "host listed " + SKILL_NAME + " from the project Skill" if skill_ok else "host did not list the project " + SKILL_NAME + " Skill",
        )
        fixture = FixtureServer(OpenAiHandler, os.path.join(root, "model-requests.json"))
        config_dir = os.path.join(root, "xdg", "config", "opencode")
        os.makedirs(config_dir, exist_ok=True)
        Path(config_dir, "opencode.json").write_text(json.dumps({
            "$schema": "https://opencode.ai/config.json",
            "provider": {"opencode": {"options": {"baseURL": fixture.endpoint + "/v1", "apiKey": "fixture"}}},
            "model": "opencode/beam-free",
        }), encoding="utf8")
        port = free_port()
        server_process = subprocess.Popen(
            [executable, "serve", "--pure", "--port", str(port), "--print-logs", "--log-level", "DEBUG"],
            cwd=project, env=env, stdin=subprocess.DEVNULL,
            stdout=open(os.path.join(root, "serve.stdout"), "wb"),
            stderr=open(os.path.join(root, "serve.stderr"), "wb"),
            start_new_session=os.name != "nt",
        )
        base = "http://127.0.0.1:" + str(port)
        health = False
        for _ in range(75):
            status, _ = api_request(base, "GET", "/global/health", timeout=2)
            if status == 200:
                health = True
                break
            time.sleep(0.2)
        if not health:
            raise RuntimeError("OpenCode server did not become healthy")
        status, body = api_request(base, "POST", "/session", {})
        if status != 200:
            raise RuntimeError("OpenCode session creation failed: " + bounded_text(body, 400))
        session_id = json.loads(body)["id"]
        instructions_log = os.path.join(root, "instructions.jsonl")
        if not hooks_supported:
            report["checks"]["session_start"] = checked(NOT_SUPPORTED, "this OpenCode build has no verified SessionStart integration")
            report["checks"]["pretool_context"] = checked(NOT_SUPPORTED, "this OpenCode build has no verified PreToolUse integration")
        waiting = wait_until(
            lambda: Path(project, ".git", "specgit-v2", "hook-context", "offers.json").is_file(),
            timeout=8,
        )
        report["evidence"]["session_start_state"] = waiting
        if hooks_supported:
            seed_ok, seed_detail = seed_pending_write(binary, project, env)
            report["evidence"]["pending_write"] = seed_detail
            report["evidence"]["pending_write_ok"] = seed_ok
            status, body = api_request(
                base, "POST", "/session/" + session_id + "/shell",
                {"agent": "build", "command": "echo host-load-probe", "hookMode": "noninteractive"},
                timeout=20,
            )
            if status != 200:
                raise RuntimeError("OpenCode shell tool failed: " + bounded_text(body, 400))
        callback = "cat >> " + shlex.quote(instructions_log)
        status, body = api_request(
            base, "POST", "/session/" + session_id + "/hook",
            {"event": "InstructionsLoaded", "matcher": "*", "hooks": [{"type": "command", "command": callback, "timeout": 5}]},
            timeout=10,
        )
        callback_registered = status == 200
        report["evidence"]["instructions_callback"] = callback_registered
        message_status, body = api_request(
            base, "POST", "/session/" + session_id + "/message",
            {
                "model": {"providerID": "opencode", "modelID": "beam-free"},
                "agent": "build",
                "hookMode": "noninteractive",
                "parts": [{"type": "text", "text": "Reply with the loaded instructions marker."}],
            },
            timeout=25,
        )
        report["evidence"]["message_status"] = message_status
        wait_until(lambda: Path(instructions_log).is_file() and Path(instructions_log).stat().st_size > 0, timeout=15)
        instructions_text = read_bounded(instructions_log, 32768) if Path(instructions_log).is_file() else ""
        guidance_event = False
        for line in instructions_text.splitlines():
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if event.get("hook_event_name") == "InstructionsLoaded" and str(event.get("file_path", "")).endswith("AGENTS.md"):
                guidance_event = True
                break
        status, messages = api_request(base, "GET", "/session/" + session_id + "/message", timeout=15)
        conversation_text = messages if status == 200 else ""
        model_requests = [
            item for item in fixture.requests
            if item.get("path", "").split("?")[0].endswith("/chat/completions")
        ]
        model_text = request_text(model_requests[-1]) if model_requests else ""
        transport_ok = message_status == 200 and bool(model_requests)
        report["checks"]["model_transport"] = checked(
            PASS if transport_ok else FAIL,
            "host completed one loopback model turn" if transport_ok else "message status=%s, model requests=%s" % (message_status, len(model_requests)),
        )
        host_log = os.path.join(root, "xdg", "data", "opencode", "log", "opencode.log")
        hook_log = parse_opencode_hooks(host_log)
        report["evidence"]["hook_events"] = {name: runs for name, runs in hook_log["events"].items()}
        report["evidence"]["hook_config"] = hook_log["loaded_events"]
        guidance_ok = GUIDANCE_MARKER in model_text
        report["checks"]["guidance"] = checked(
            PASS if guidance_ok else FAIL,
            "AGENTS.md guidance reached the model request"
            + (" after InstructionsLoaded reported AGENTS.md" if guidance_event else " (InstructionsLoaded event not observed)")
            if guidance_ok
            else "guidance in model request=%s, InstructionsLoaded AGENTS.md=%s" % (GUIDANCE_MARKER in model_text, guidance_event),
        )
        if hooks_supported:
            session_hook = hook_summary(hook_log["events"], "SessionStart") and waiting
            session_context = SESSION_MARKER in model_text and SESSION_RULE in model_text
            report["checks"]["session_start"] = checked(
                PASS if session_hook and session_context else FAIL,
                "SessionStart hook succeeded, recorded the offer and its rules reached the model request"
                if session_hook and session_context
                else "SessionStart hook=%s, offer state=%s, context in model request=%s"
                % (session_hook, waiting, session_context),
            )
            pretool_hook = hook_summary(hook_log["events"], "PreToolUse")
            pretool_messages = RECOVERY_MARKER in conversation_text
            pretool_model = RECOVERY_MARKER in model_text
            seed_ok = report["evidence"].get("pending_write_ok") is True
            report["checks"]["pretool_context"] = checked(
                PASS if pretool_hook and pretool_messages and pretool_model and seed_ok else FAIL,
                "PreToolUse hook added recovery context to the tool result and the next model request"
                if pretool_hook and pretool_messages and pretool_model and seed_ok
                else "PreToolUse hook=%s, tool result=%s, model request=%s, seed=%s"
                % (pretool_hook, pretool_messages, pretool_model, seed_ok),
            )
        return finalize(report)
    except Exception as error:  # noqa: BLE001
        report["status"] = FAIL
        report["notes"].append("probe error: " + bounded_text(repr(error), 800))
        return report
    finally:
        if server_process is not None:
            stop_process(server_process)
        if fixture is not None:
            fixture.close()


def probe_codex(binary, executable, args, root):
    report = host_report(None)
    if not executable:
        report["status"] = "not-installed"
        report["notes"].append("Codex CLI not found on PATH; pass --codex /absolute/path to probe it.")
        return report
    version, _ = version_of(executable, root, root)
    report["version"] = version
    project = os.path.join(root, "project")
    os.makedirs(project, exist_ok=True)
    prepare_dirs(root)
    fixture = None
    try:
        help_result = run_bounded([executable, "exec", "--help"], cwd=root, env=base_environment(root, root), timeout=20)
        help_text = help_result["stdout"] + help_result["stderr"]
        if "--json" not in help_text or "--skip-git-repo-check" not in help_text or "--ephemeral" not in help_text:
            report["status"] = FAIL
            report["notes"].append("installed Codex CLI has no compatible non-interactive exec interface")
            return report
        git_fixture(root, project)
        setup = setup_project(binary, "codex", project, root)
        report["evidence"]["setup_assets"] = setup["assets"]
        hooks_written = Path(project, ".codex", "hooks.json").is_file()
        env = setup["env"]
        codex_home = os.path.join(root, "codex-home")
        os.makedirs(codex_home, exist_ok=True)
        fixture = FixtureServer(OpenAiHandler, os.path.join(root, "model-requests.json"))
        Path(codex_home, "config.toml").write_text(
            "model = \"fixture-model\"\n"
            "model_provider = \"fixture\"\n"
            "[model_providers.fixture]\n"
            "name = \"Fixture\"\n"
            "base_url = \"" + fixture.endpoint + "/v1\"\n"
            "env_key = \"FIXTURE_API_KEY\"\n"
            "wire_api = \"responses\"\n",
            encoding="utf8",
        )
        env.update({"CODEX_HOME": codex_home, "FIXTURE_API_KEY": "sk-fixture"})
        result = run_bounded(
            [
                executable, "exec", "--json", "--ephemeral", "--skip-git-repo-check",
                "-C", project, "Reply with the loaded instructions marker.",
            ],
            cwd=project, env=env, timeout=args.timeout,
            stdout_path=os.path.join(root, "host.jsonl"),
            stderr_path=os.path.join(root, "host.stderr"),
        )
        report["evidence"]["host_exit"] = result["exit"]
        report["evidence"]["timed_out"] = result["timed_out"]
        report["checks"]["session_exit"] = checked(
            PASS if result["exit"] == 0 and not result["timed_out"] else FAIL,
            "host session exited zero" if result["exit"] == 0 and not result["timed_out"] else "host session exit=%s timed_out=%s" % (result["exit"], result["timed_out"]),
        )
        first = first_request(fixture.requests)
        first_text = request_text(first) if first else ""
        skills_ok = "<skills_instructions>" in first_text and SKILL_NAME in first_text and "specgit-native/SKILL.md" in first_text
        report["checks"]["skill"] = checked(
            PASS if skills_ok else FAIL,
            "host skills instructions listed the project " + SKILL_NAME + " Skill"
            if skills_ok else "host skills instructions did not list the project " + SKILL_NAME + " Skill",
        )
        guidance_ok = (
            ("# AGENTS.md instructions for" in first_text or "Instructions from:" in first_text)
            and GUIDANCE_MARKER in first_text
        )
        report["checks"]["guidance"] = checked(
            PASS if guidance_ok else FAIL,
            "AGENTS.md instructions reached the model transport" if guidance_ok else "AGENTS.md instructions were not observed in the model request",
        )
        hook_state = Path(project, ".git", "specgit-v2", "hook-context", "offers.json").is_file()
        session_context = SESSION_RULE in first_text
        if hooks_written and hook_state and session_context:
            report["checks"]["session_start"] = checked(PASS, "SessionStart hook ran and its rules reached the model request")
            report["checks"]["pretool_context"] = checked(NOT_CHECKED, "this probe does not drive a tool call for Codex")
            report["hooks_supported"] = True
        else:
            report["checks"]["session_start"] = checked(
                NOT_CHECKED,
                "project hooks are not trusted by the host; SpecGit does not automate Codex hook trust",
            )
            report["checks"]["pretool_context"] = checked(
                NOT_CHECKED,
                "project hooks are not trusted by the host; SpecGit does not automate Codex hook trust",
            )
            report["hooks_supported"] = hooks_written
            report["notes"].append("Codex requires a host /hooks trust review for project hooks; written registration is not delivery evidence.")
        report["hook_trust"] = "review_in_host_required"
        return finalize(report)
    except Exception as error:  # noqa: BLE001
        report["status"] = FAIL
        report["notes"].append("probe error: " + bounded_text(repr(error), 800))
        return report
    finally:
        if fixture is not None:
            fixture.close()


def self_test():
    root = Path(tempfile.mkdtemp(prefix="specgit-host-probe-self-test-"))
    try:
        project = root / "project"
        project.mkdir()
        prepare_dirs(str(root))
        git_fixture(str(root), str(project))
        if not (project / ".git").exists() or not (project / ".specgit.yaml").is_file():
            raise RuntimeError("fixture did not create the expected project files")
        events = {
            "events": {
                "SessionStart": [{"exit": 0, "stdout": 538}],
                "PreToolUse": [{"exit": 0, "stdout": 243}],
            }
        }
        if not hook_summary(events["events"], "SessionStart") or not hook_summary(events["events"], "PreToolUse"):
            raise RuntimeError("hook summary did not accept successful non-empty runs")
        report = host_report("fixture")
        report["checks"]["skill"] = checked(PASS, "fixture")
        finalize(report)
        if report["status"] != PASS:
            raise RuntimeError("report finalization did not accept a passing check")
        print(json.dumps({"self_test": "pass", "fixture": "created and inspected"}, indent=2))
        return 0
    finally:
        shutil.rmtree(root, ignore_errors=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--host", action="append", choices=HOSTS + ("all",), default=None, help="host to probe; repeatable, or all (default: all)")
    parser.add_argument("--binary", type=Path, help="absolute path to the installed shared specgit executable")
    parser.add_argument("--claude", help="absolute path to the Claude Code CLI (default: PATH)")
    parser.add_argument("--codex", help="absolute path to the Codex CLI (default: PATH)")
    parser.add_argument("--opencode", help="absolute path to the OpenCode CLI (default: PATH)")
    parser.add_argument("--timeout", type=int, default=90, help="per-host non-interactive session timeout in seconds (default: 90)")
    parser.add_argument("--keep", action="store_true", help="keep the isolated evidence directory")
    parser.add_argument("--self-test", action="store_true", help="run offline fixture and report checks only")
    args = parser.parse_args()
    if args.self_test:
        return self_test()
    if args.binary is None:
        parser.error("--binary is required")
    binary = args.binary.expanduser()
    if not binary.is_absolute() or not binary.is_file() or not os.access(binary, os.X_OK):
        parser.error("--binary must be an absolute executable file")
    binary = str(binary.resolve())
    hosts = args.host or list(HOSTS)
    if "all" in hosts:
        if len(hosts) != 1:
            parser.error("--host all cannot be combined with another host")
        hosts = list(HOSTS)
    if len(set(hosts)) != len(hosts):
        parser.error("--host values must be unique")
    selected = {
        "claude": args.claude,
        "codex": args.codex,
        "opencode": args.opencode,
    }
    version = specgit_version(binary, tempfile.gettempdir())
    report = {
        "schema_version": SCHEMA_VERSION,
        "probe": "host-load",
        "binary": {
            "path": binary,
            "sha256": sha256_file(binary),
            "version": version,
        },
        "hosts": {},
        "passed": False,
        "evidence_directory": None,
    }
    base = Path(tempfile.mkdtemp(prefix="specgit-host-load-"))
    adapters = {"claude": probe_claude, "codex": probe_codex, "opencode": probe_opencode}
    try:
        for host in hosts:
            executable = resolve_executable(selected[host], host)
            host_root = base / host
            host_root.mkdir()
            report["hosts"][host] = adapters[host](binary, executable, args, str(host_root))
            report["hosts"][host]["evidence_directory"] = cleanup_root(str(host_root), args.keep)
        report["passed"] = all(item["status"] == PASS for item in report["hosts"].values())
        if args.keep:
            report["evidence_directory"] = str(base)
        else:
            cleanup_root(str(base), False)
    finally:
        if not args.keep:
            shutil.rmtree(base, ignore_errors=True)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())