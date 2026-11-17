# TAP-02 reference material

Copied unchanged from the TapeOut standards repository, [TapeOutProtocol/TAPs](https://github.com/TapeOutProtocol/TAPs),
`assets/tap-02/`:

| File | What it is | Licence |
|---|---|---|
| `vectors.json` | The TAP-02 test vectors (format `tap-netlist-vectors/1`) | CC0-1.0, as the TAP text |
| `reference.py` | The TAP-02 reference implementation | MIT (stated in its header) |
| `popcount8_3151.hex` | The on-chain bytes of circuit #3151 of a BNB processor, used by the vectors | CC0-1.0 |

Gatefold's tests run its decoder and evaluator against `vectors.json`, and `scripts/crosscheck_reference.py` runs
`reference.py` on Gatefold's compiled songs.
