"""Run the real setup/post bundles and pinned upstream tests on one runner.

Each runner supplies one randomized baseline/split pair for cold, warm, and
module-hit/build-miss states. Caches use a unique dependency-hash nonce and only
this experiment's own exact keys are deleted. No cache-service credentials,
source environment, raw action logs, or signed URLs are exported as artifacts.
"""
import argparse
import hashlib
import json
import os
import pathlib
import random
import shutil
import subprocess
import threading
import time

import psutil

ROOT = pathlib.Path(__file__).resolve().parent
CASES = {case["id"]: case for case in json.loads((ROOT / "cases.json").read_text())}
BASELINE = "90ad2b35f69faf97585ad74d28fa006d2739b7af"
CANDIDATE = "ad9941188fbcb38febe37eac394b80bd9bc34fc8"


def command_json(args):
    return json.loads(subprocess.check_output(args, text=True, encoding="utf-8"))


def read_commands(file):
    """Parse @actions/core file-command key/value and multiline syntax."""
    if not file.exists():
        return {}
    lines = file.read_text(encoding="utf-8-sig").splitlines()
    result = {}
    i = 0
    while i < len(lines):
        line = lines[i]
        i += 1
        if "<<" in line and ("=" not in line or line.index("<<") < line.index("=")):
            name, delimiter = line.split("<<", 1)
            value = []
            while i < len(lines) and lines[i] != delimiter:
                value.append(lines[i])
                i += 1
            if i == len(lines):
                raise RuntimeError("Incomplete action file command")
            i += 1
            result[name] = "\n".join(value)
        elif "=" in line:
            name, value = line.split("=", 1)
            result[name] = value
    return result


def monitored(args, env, cwd, phase_file):
    """Sum process-tree RSS at 100 ms intervals; not unique physical memory."""
    started = time.perf_counter()
    process = subprocess.Popen(args, cwd=cwd, env=env, stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")
    text = []

    def stream():
        for line in process.stdout:
            print(line.rstrip(), flush=True)
            text.append(line)

    reader = threading.Thread(target=stream, daemon=True)
    reader.start()
    peak_rss = peak_private = 0
    measurements = 0
    names = set()
    seen_cpu = {}
    available_min = psutil.virtual_memory().available
    tree = psutil.Process(process.pid)
    while True:
        now = time.perf_counter()
        try:
            descendants = [tree] + tree.children(recursive=True)
        except psutil.Error:
            descendants = []
        rss = private = 0
        for item in descendants:
            try:
                info = item.memory_info()
                rss += info.rss
                private += getattr(info, "private", 0)
                cpu = item.cpu_times()
                seen_cpu[(item.pid, item.create_time())] = cpu.user + cpu.system
                names.add(item.name())
            except psutil.Error:
                continue
        peak_rss = max(peak_rss, rss)
        peak_private = max(peak_private, private)
        available_min = min(available_min, psutil.virtual_memory().available)
        measurements += 1
        if process.poll() is not None:
            break
        # This is the sampler's schedule, not waiting/polling for an external
        # workflow. The measured sampling interval is included in metadata.
        time.sleep(max(0, 0.1 - (time.perf_counter() - now)))
    reader.join()
    elapsed = time.perf_counter() - started
    result = {"seconds": elapsed, "exitCode": process.returncode,
              "peakProcessTreeRssBytes": peak_rss,
              "peakProcessTreePrivateBytesWindows": peak_private if os.name == "nt" else None,
              "minimumSystemAvailableBytes": available_min,
              "sampleCount": measurements, "samplingIntervalSeconds": 0.1,
              "observedProcessNames": sorted(names), "sampledCpuSeconds": sum(seen_cpu.values())}
    phase_file.write_text(json.dumps(result, indent=2), encoding="utf-8")
    if process.returncode:
        raise RuntimeError(f"Measured subprocess failed with exit code {process.returncode}")
    return result, "".join(text)


def delete_own_caches(keys, repo):
    """Delete only exact keys derived from this runner's experiment nonce."""
    entries = command_json(["gh", "api", f"repos/{repo}/actions/caches?per_page=100"])["actions_caches"]
    for entry in entries:
        if entry["key"] in keys:
            subprocess.run(["gh", "api", "--method", "DELETE",
                            f"repos/{repo}/actions/caches/{entry['id']}"], check=True)
            print(f"Removed owned experimental cache id={entry['id']}", flush=True)


def disk_inventory(directory):
    count = size = 0
    for parent, _, files in os.walk(directory):
        for file in files:
            try:
                size += (pathlib.Path(parent) / file).stat().st_size
                count += 1
            except OSError:
                pass
    return {"bytes": size, "files": count}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--case", required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--sample", required=True, type=int)
    args = parser.parse_args()
    case = CASES[args.case]
    if args.version not in case["versions"]:
        raise ValueError("Unsupported case/version")
    source = pathlib.Path(os.environ["GITHUB_WORKSPACE"]) / "source"
    source_sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=source, text=True).strip()
    if source_sha != case["sha"]:
        raise ValueError("Source revision differs from case definition")
    temp = pathlib.Path(os.environ["RUNNER_TEMP"]) / "runner-hours-cache-v1" / args.case
    # One cache location is reused for both variants to prevent path/version
    # differences; variant key namespaces are already distinct in the action.
    modules, build = temp / "modules", temp / "build"
    temp.mkdir(parents=True, exist_ok=True)
    out = ROOT / "results"
    out.mkdir(exist_ok=True)
    nonce = f"runner-hours-v1:{os.environ['GITHUB_RUN_ID']}:{os.environ['GITHUB_RUN_ATTEMPT']}:{args.case}:{args.version}:{args.sample}"
    nonce_path = source / ".runner-hours-cache-nonce"
    nonce_path.write_text(nonce, encoding="utf-8")
    owned_keys = set()
    baseline_root = pathlib.Path(os.environ["GITHUB_WORKSPACE"]) / "baseline-action"
    split_root = pathlib.Path(os.environ["GITHUB_WORKSPACE"]) / "split-action"
    result = {"case": case, "version": args.version, "sample": args.sample,
              "runId": os.environ["GITHUB_RUN_ID"], "runAttempt": os.environ["GITHUB_RUN_ATTEMPT"],
              "baseline": BASELINE, "candidate": CANDIDATE,
              "runnerOS": os.environ.get("RUNNER_OS"), "runnerArch": os.environ.get("RUNNER_ARCH"),
              "imageOS": os.environ.get("ImageOS"), "imageVersion": os.environ.get("ImageVersion"),
              "cpus": psutil.cpu_count(), "systemMemoryBytes": psutil.virtual_memory().total,
              "randomizationSeed": hashlib.sha256(nonce.encode()).hexdigest(),
              "memoryMetric": "100ms sampled sum of process-tree RSS; shared pages can be double counted",
              "measurements": []}

    def execute(variant, scenario, order_index):
        # Each logical CI job starts with the same checkout. `make test` may
        # tidy the exp module, so reset tracked sources between measurements.
        subprocess.run(["git", "restore", "--worktree", "--", "."], cwd=source, check=True)
        for directory in [modules, build]:
            if directory.exists():
                if directory == modules:
                    cleanup_env = dict(os.environ, GOMODCACHE=str(modules), GOTOOLCHAIN="local")
                    subprocess.run(["go", "clean", "-modcache"], env=cleanup_env, cwd=source, check=True)
                else:
                    shutil.rmtree(directory)
        phase = temp / f"{variant}-{scenario}"
        phase.mkdir()
        for command_file in ["outputs", "states", "environment", "paths"]:
            (phase / command_file).touch()
        env = dict(os.environ)
        env.update({"GITHUB_WORKSPACE": str(source), "GOMODCACHE": str(modules), "GOCACHE": str(build),
                "GOTOOLCHAIN": "local", "GOTELEMETRY": "off",
                    "INPUT_GO-VERSION": args.version, "INPUT_CHECK-LATEST": "false", "INPUT_CACHE": "true",
                    "INPUT_CACHE-DEPENDENCY-PATH": f"{case['dependency']}\n.runner-hours-cache-nonce",
                    "INPUT_GO-VERSION-FILE": "", "INPUT_ARCHITECTURE": "", "INPUT_TOKEN": "",
                    "GITHUB_OUTPUT": str(phase / "outputs"), "GITHUB_STATE": str(phase / "states"),
                    "GITHUB_ENV": str(phase / "environment"), "GITHUB_PATH": str(phase / "paths")})
        action_root = baseline_root if variant == "baseline" else split_root
        setup, setup_text = monitored(["node", str(action_root / "dist/setup/index.js")], env, source, phase / "setup.json")
        outputs = read_commands(phase / "outputs")
        env.update(read_commands(phase / "environment"))
        state = read_commands(phase / "states")
        prepared_keys = [state.get("CACHE_KEY")] if variant == "baseline" else [
            entry["primaryKey"] for entry in json.loads(state.get("CACHE_ENTRIES", "[]"))]
        owned_keys.update(key for key in prepared_keys if key)
        env.update({"STATE_" + key: value for key, value in state.items()})
        path_file = phase / "paths"
        if path_file.exists():
            env["PATH"] = os.pathsep.join(reversed(path_file.read_text(encoding="utf-8-sig").splitlines())) + os.pathsep + env["PATH"]
        env.update(case["environment"])
        actual_version = subprocess.check_output(["go", "version"], cwd=source, env=env, text=True).strip()
        if f"go{args.version} " not in actual_version:
            raise RuntimeError(f"Wrong toolchain: {actual_version}")
        workload = []
        for index, command in enumerate(case["commands"]):
            stats, _ = monitored(command, env, source, phase / f"workload-{index}.json")
            workload.append(stats)
        # Follow the real runner's ordering: post executes after upstream tests.
        post, post_text = monitored(["node", str(action_root / "dist/cache-save/index.js")], env, source, phase / "post.json")
        if variant == "baseline":
            key = state.get("CACHE_KEY")
            entries = [{"kind": "combined", "primaryKey": key, "matchedKey": state.get("CACHE_RESULT")}]
        else:
            entries = json.loads(state.get("CACHE_ENTRIES", "[]"))
        keys = [entry["primaryKey"] for entry in entries if entry.get("primaryKey")]
        if len(keys) != (1 if variant == "baseline" else 2):
            raise RuntimeError("Action cache state was not generated")
        owned_keys.update(keys)
        hits = {entry["kind"]: entry.get("matchedKey") == entry["primaryKey"] for entry in entries}
        if scenario == "cold" and any(hits.values()):
            raise RuntimeError("Cold pair unexpectedly restored an exact entry")
        if scenario == "warm" and not all(hits.values()):
            raise RuntimeError("Warm pair did not restore every exact entry")
        if scenario == "module-hit" and variant == "baseline" and any(hits.values()):
            raise RuntimeError("Combined partial-hit control did not miss")
        if scenario == "module-hit" and variant == "split" and hits != {"modules": True, "build": False}:
            raise RuntimeError(f"Wrong partial-hit state: {hits}")
        if any(term in setup_text + post_text for term in ["Failed to restore:", "Failed to save:", "Save modules cache failed", "Save build cache failed", "Unable to save cache"]):
            raise RuntimeError("Cache operation warning invalidates measurement")
        record = {"variant": variant, "scenario": scenario, "orderIndex": order_index,
              "actualGoVersion": actual_version,
                  "cacheHitOutput": outputs.get("cache-hit"), "entries": entries,
                  "setup": setup, "workload": workload, "post": post,
                  "cacheSeconds": setup["seconds"] + post["seconds"],
                  "totalMeasuredSeconds": setup["seconds"] + sum(x["seconds"] for x in workload) + post["seconds"],
                  "inventory": {"modules": disk_inventory(modules), "build": disk_inventory(build)}}
        entries_live = command_json(["gh", "api", f"repos/{os.environ['GITHUB_REPOSITORY']}/actions/caches?per_page=100"])["actions_caches"]
        record["cacheRecords"] = [{key: c[key] for key in ["id", "key", "version", "ref", "size_in_bytes", "created_at"]}
                                   for c in entries_live if c["key"] in keys]
        result["measurements"].append(record)
        (out / "sample.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
        print(json.dumps({"variant": variant, "scenario": scenario, "hits": hits,
                          "totalSeconds": record["totalMeasuredSeconds"]}), flush=True)
        return entries

    try:
        for scenario_index, scenario in enumerate(["cold", "warm", "module-hit"]):
            if scenario == "module-hit":
                to_remove = {key for key in owned_keys if not key.startswith("setup-go-modules-")}
                delete_own_caches(to_remove, os.environ["GITHUB_REPOSITORY"])
            # Exactly five pairs per order in the accepted ten-sample series.
            # Balance separately for every case/version and each cache state.
            offset = int(hashlib.sha256((args.case + args.version).encode()).hexdigest()[:8], 16)
            order = ["baseline", "split"] if (args.sample + scenario_index + offset) % 2 else ["split", "baseline"]
            for index, variant in enumerate(order):
                execute(variant, scenario, index)
        result["complete"] = True
    finally:
        # User explicitly authorized cleanup of only this new harness's caches.
        delete_own_caches(owned_keys, os.environ["GITHUB_REPOSITORY"])
        result["ownedCachesCleaned"] = True
        (out / "sample.json").write_text(json.dumps(result, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
