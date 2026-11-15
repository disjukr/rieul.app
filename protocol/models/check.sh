#!/bin/sh
# Check bounded models and ensure deliberately unsafe variants still fail as expected.
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
trap 'exit 1' HUP INT TERM

sha256=936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88
jar=${TLA2TOOLS_JAR:-"$scratch/tla2tools.jar"}
if [ -z "${TLA2TOOLS_JAR:-}" ]; then
  curl -fsSL https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar -o "$jar"
fi
jar=$(CDPATH= cd -- "$(dirname -- "$jar")" && pwd)/$(basename -- "$jar")
if command -v sha256sum >/dev/null 2>&1; then
  digest=$(sha256sum <"$jar")
else
  digest=$(shasum -a 256 <"$jar")
fi
if [ "${digest%% *}" != "$sha256" ]; then
  echo "Unexpected SHA-256 for $jar (expected official TLA+ tools v1.7.4)" >&2
  exit 1
fi

cd "$root"
if [ "$#" -eq 0 ]; then
  set -- $(cut -d '|' -f 1 checks.txt | sort -u)
fi

for suite do
  case "$suite" in
    ''|*[!a-z0-9-]*) echo "Invalid model suite: $suite" >&2; exit 1 ;;
  esac
  grep -q "^$suite|" checks.txt || { echo "Unknown model suite: $suite" >&2; exit 1; }
  while IFS='|' read -r dir module config invariant; do
    [ "$dir" = "$suite" ] || continue
    case_dir="$scratch/$dir-$config"
    mkdir "$case_dir"
    cp "$dir"/*.tla "$dir/$config.cfg" "$case_dir"
    status=0
    (cd "$case_dir" && java -XX:+UseParallelGC -Xmx1g -cp "$jar" tlc2.TLC \
      -workers 1 -config "$config.cfg" "$module") >"$case_dir/tlc.log" 2>&1 || status=$?
    if [ -z "$invariant" ]; then
      if [ "$status" -eq 0 ] && grep -Fq 'Model checking completed. No error has been found.' "$case_dir/tlc.log"; then
        printf '%s/%s: passed\n' "$dir" "$config"
        continue
      fi
    elif [ "$status" -eq 12 ] && grep -Fxq "Error: Invariant $invariant is violated." "$case_dir/tlc.log"; then
      printf '%s/%s: caught expected %s violation\n' "$dir" "$config" "$invariant"
      continue
    fi
    printf 'Unexpected TLC result for %s/%s (exit %s; expected %s)\n' \
      "$dir" "$config" "$status" "${invariant:-success}" >&2
    cat "$case_dir/tlc.log" >&2
    exit 1
  done < checks.txt
done
