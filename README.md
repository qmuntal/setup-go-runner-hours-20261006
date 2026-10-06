# setup-go runner-hours and memory experiment

This experiment compares the unmodified combined setup-go commit 90ad2b35f69faf97585ad74d28fa006d2739b7af with the split-cache commit ad9941188fbcb38febe37eac394b80bd9bc34fc8 using real pinned upstream test workloads. The user authorized Linux and upstream test execution for this investigation, and cleanup of only the new experiment's exact cache keys. Earlier seven-project benchmark caches are not touched.

## Design

Each case/version/sample executes on one fresh hosted VM. It measures both action variants in balanced alternating order for three cache states: cold, exact full hit, and modules hit/build miss. Ten independently dispatched runner pairs per case/version are intended; a pilot validates the harness before the full series. Toolchain and memory-sampler installation occur outside measurement. Case definitions contain exact source revisions, toolchains, runner labels, dependency hash inputs, and upstream commands. Go test result caching follows the real workflow: forcing count=1 would measure a different workload. Cache prefixes are changed only by adding a unique benchmark nonce to the dependency hash, not by modifying either action.

The harness invokes the actual setup and post JavaScript bundles from a local Node24 action, preserving the cache-service environment without exposing it. It parses action state/output/env files and passes the same state to the real post bundle after the upstream commands. This isolates setup/post execution and measures subprocess elapsed time rather than runner step timestamp rounding. Each sample validates expected cache-hit states, toolchain versions, test success, and persisted cache records.

Memory is sampled every 100 ms as the sum of RSS for the measured process tree. This can double-count shared pages and miss sub-100-ms spikes; Windows private bytes are also recorded. These are peak process-memory observations, not cache disk size or allocation counts. CPU times are sampled and may undercount exited short-lived children. An observer runs equally for both variants.

## Monthly model

Use observed workflow jobs and cache-hit/miss classifications in the last complete 30-day window, grouped by repository, runner OS/architecture, Go release, and state. Estimate signed runner hours as the sum of job counts multiplied by the mean paired elapsed-time difference, divided by 3,600; derive uncertainty by resampling independent runner pairs. Do not multiply a patch-upgrade gain by all workflow runs. Current action-only cache-layout effects must be distinguished from unrelated setup-go v5/v6/v7 migration differences. Report unresolved cache-state counterfactuals and workload mismatches as sensitivity bounds rather than precise claims.

No Linux/Windows result is extrapolated to unmeasured macOS. Failed, cancelled, unavailable-log, and unsupported historical toolchain jobs are counted but not silently included in a successful-job estimate. Positive, zero, and negative savings are all reported. Elapsed runner time is not billable time or workflow critical-path latency; full job rounding and account costs are outside this experiment unless separately measured.

The primary source repositories are prometheus/client_golang and spf13/viper. Hugo's longer current workflow is examined for monthly volume but is not approximated by its old bounded build benchmark. Full reproduction is a separate follow-up. Both action implementations remain unchanged, and no cross-OS module sharing is evaluated.
