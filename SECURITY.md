# Security

Please report a vulnerability through
[GitHub's private reporting](https://github.com/Marc-Dvci/gatefold/security/advisories/new), not in a public issue.
The supported version is the `main` branch.

The reports that matter most are anything that:

- moves USD₮0 held by `GatefoldRecords` to anyone other than the payees it credited;
- lets a signed licence authorization pay for a different song or a different licensee than the one signed for;
- makes the player play something other than the circuit stored on X Layer while it reports a match with `step()`;
- lets a netlist read from the chain hang or crash the page instead of being refused (TAP-02 §7).

Gatefold holds no keys: tape-outs and licences are signed in the visitor's own wallet.
