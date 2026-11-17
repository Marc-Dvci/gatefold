"""Replay every Gatefold song with the official TAP-02 reference implementation and compare, sample by sample.

The reference implementation (third_party/tap-02/reference.py, from the TapeOut standards repository) is a second,
independent evaluator: it shares no code with Gatefold. This script loads each song netlist from examples/songs/, gives
it the instrument netlists from examples/instruments/ for its REF records, runs the first samples from the all-zero
state with the pins the export used, and requires every output word to equal the one Gatefold produced.

    python scripts/crosscheck_reference.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "third_party" / "tap-02"))

import reference as tap  # noqa: E402


def load_instruments() -> dict[tuple[bytes, int], tap.Circuit]:
    out: dict[tuple[bytes, int], tap.Circuit] = {}
    for f in sorted((ROOT / "examples" / "instruments").glob("*.json")):
        d = json.loads(f.read_text(encoding="utf-8"))
        c = tap.load(bytes.fromhex(d["netlist"][2:]), d["nIn"], d["nOut"])
        cpu = bytes.fromhex(d["previewCircuit"]["cpu"][2:])
        out[(cpu, int(d["previewCircuit"]["id"]))] = c
    return out


def main() -> int:
    instruments = load_instruments()
    failures = 0
    for f in sorted((ROOT / "examples" / "songs").glob("*.json")):
        if f.name == "summary.json":
            continue
        d = json.loads(f.read_text(encoding="utf-8"))
        song = tap.load(bytes.fromhex(d["netlist"][2:]), d["nIn"], d["nOut"], lambda cpu, cid: instruments.get((cpu, cid)))
        pins = [1, 1, 0] if d["pins"] == {"intensity": 3, "drive": False} else None
        assert pins is not None, "unexpected pins in the export"
        state = [0] * song.n_state
        expected = d["firstSamples"]
        mismatch = None
        for t, want in enumerate(expected):
            state, outs = tap.beat(song, state, pins)
            got = sum(bit << i for i, bit in enumerate(outs))
            if got != want:
                mismatch = (t, got, want)
                break
        if mismatch:
            failures += 1
            print(f"{f.stem}: beat {mismatch[0]}: reference {mismatch[1]}, Gatefold {mismatch[2]}")
        else:
            print(f"{f.stem}: {len(expected)} samples identical ({song.n_gates} gates, {song.n_state} state bits)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
