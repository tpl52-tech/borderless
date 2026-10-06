# Devbox usage aggregator (design §15.2). Read-only, runs ON THE BOX.
#
# Aggregates claude transcripts on the box rather than shipping raw lines to the Mac (shipping raw
# lines was 48 MB and timed out). Honors explicit byte offsets BEFORE discovery; 16 MiB budget per
# invocation. Consecutive-duplicate message-id dedupe (usage rows repeat verbatim; naive summing
# overstated output by 96%). Rolls subagent transcripts up to the parent.
#
# TODO (design §15.2): implement the per-file byte-mark + dedupe + per-model token sums, emit JSON.

BEGIN {
  print "{ \"error\": \"aggregate-usage.awk: not implemented (scaffold) — see design §15.2\" }"
  exit 0
}
