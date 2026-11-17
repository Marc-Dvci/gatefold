# Examples

What Gatefold produces, to open without running anything. `npm run songs` writes all of it.

| Folder | What it holds |
|---|---|
| [`audio/`](audio/) | Each song rendered from its circuit, one pass, as MP3 (from 24 kHz mono) |
| [`songs/`](songs/) | Each song's TAP-02 netlist with its stats, the REF records to its instruments, and its first 24,000 output words |
| [`instruments/`](instruments/) | Each instrument's netlist, as a tape-out stores it |

The songs' REF records point at the instruments on the local preview processor
(`0x00000000000000000000000000000000ca55e77e`, ids 1 to 5). A live tape-out compiles the same songs against the
instruments' ids on the Gatefold processor; the instrument netlists themselves are the same bytes.
