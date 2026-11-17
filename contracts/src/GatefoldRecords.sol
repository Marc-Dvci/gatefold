// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The read side of a TapeOut processor contract (TAP-02 §6) and its ERC-721 ownership.
interface IProcessor {
    function ownerOf(uint256 id) external view returns (address);
    function netlist(uint256 id) external view returns (bytes memory);
    function circuitInfo(uint256 id) external view returns (uint32 nIn, uint32 nOut, uint32 nState, uint32 gateCount);
}

/// @notice The TapeOut processor factory: tells real processors from look-alikes.
interface IProcessorFactory {
    function isCPU(address cpu) external view returns (bool);
}

/// @notice USD₮0 on X Layer: an ERC-20 with EIP-3009 signed transfers.
interface IERC20Auth {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

/// @title Gatefold Records
/// @notice Releases and licences for songs and instruments that are TapeOut circuits.
///
/// A release is a circuit put up for licence by whoever owns its NFT. When it is released, the contract reads the
/// circuit's own netlist from the processor and records every released circuit it references with a TAP-02 REF
/// record as a parent: the instruments a song plays, or the song a remix is built on.
///
/// A licence is paid in USD₮0. A platform fee goes to the treasury; of the rest, the release's upstream share is split
/// equally among its parents, each of which passes on its own upstream share the same way, and the remainder goes to
/// the current owner of the circuit. Rights therefore follow the circuit NFT, and every unit paid is credited to
/// someone: the credits of one payment always add up to the amount paid. Payees withdraw what they are owed.
contract GatefoldRecords {
    struct Release {
        address cpu;
        uint64 id;
        uint128 price;
        uint16 upstreamBps;
        bool exists;
    }

    uint16 public constant MAX_BPS = 10_000;
    uint256 public constant MAX_PARENTS = 8;
    uint256 public constant MAX_DEPTH = 3;

    IERC20Auth public immutable token;
    IProcessorFactory public immutable factory;
    address public immutable treasury;
    uint16 public immutable feeBps;

    mapping(bytes32 key => Release) public releases;
    mapping(bytes32 key => bytes32[]) internal _parents;
    mapping(bytes32 key => mapping(address licensee => bool)) public licensed;
    mapping(address payee => uint256) public owed;
    uint256 public totalOwed;
    uint256 private _lock = 1;

    event Released(
        bytes32 indexed key,
        address indexed cpu,
        uint256 indexed id,
        uint128 price,
        uint16 upstreamBps,
        bytes32[] parents,
        string meta
    );
    event PriceSet(bytes32 indexed key, uint128 price);
    event Licensed(bytes32 indexed key, address indexed licensee, address indexed payer, uint256 amount);
    event Credited(bytes32 indexed key, address indexed payee, uint256 amount);
    event Withdrawn(address indexed payee, uint256 amount);

    error NotAProcessor(address cpu);
    error NotCircuitOwner();
    error AlreadyReleased();
    error NotReleased();
    error BadShare();
    error MalformedNetlist(uint256 at);
    error NonceNotBound();
    error NothingOwed();
    error TransferFailed();
    error Reentered();

    modifier nonReentrant() {
        if (_lock != 1) revert Reentered();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(IERC20Auth token_, IProcessorFactory factory_, address treasury_, uint16 feeBps_) {
        if (feeBps_ > 1_000) revert BadShare();
        token = token_;
        factory = factory_;
        treasury = treasury_;
        feeBps = feeBps_;
    }

    function keyOf(address cpu, uint256 id) public pure returns (bytes32) {
        return keccak256(abi.encode(cpu, id));
    }

    /// @notice Put a circuit you own up for licence. Its released REF targets become its parents.
    function release(address cpu, uint256 id, uint128 price, uint16 upstreamBps, string calldata meta)
        external
        returns (bytes32 key)
    {
        if (!factory.isCPU(cpu)) revert NotAProcessor(cpu);
        if (IProcessor(cpu).ownerOf(id) != msg.sender) revert NotCircuitOwner();
        if (upstreamBps > MAX_BPS) revert BadShare();
        key = keyOf(cpu, id);
        if (releases[key].exists) revert AlreadyReleased();
        (address[] memory cpus, uint64[] memory ids) = refTargets(IProcessor(cpu).netlist(id));
        bytes32[] storage parents = _parents[key];
        for (uint256 i = 0; i < cpus.length && parents.length < MAX_PARENTS; i++) {
            bytes32 pk = keyOf(cpus[i], ids[i]);
            if (!releases[pk].exists || _contains(parents, pk)) continue;
            parents.push(pk);
        }
        releases[key] = Release({cpu: cpu, id: uint64(id), price: price, upstreamBps: upstreamBps, exists: true});
        emit Released(key, cpu, id, price, upstreamBps, parents, meta);
    }

    /// @notice Change the licence price. Only the circuit's current owner may.
    function setPrice(bytes32 key, uint128 price) external {
        Release storage r = releases[key];
        if (!r.exists) revert NotReleased();
        if (IProcessor(r.cpu).ownerOf(r.id) != msg.sender) revert NotCircuitOwner();
        r.price = price;
        emit PriceSet(key, price);
    }

    /// @notice Buy a licence for `licensee` (a game, a site's container, a wallet) after approving the token.
    function license(bytes32 key, address licensee) external nonReentrant {
        Release storage r = releases[key];
        if (!r.exists) revert NotReleased();
        uint256 price = r.price;
        if (price > 0) _pull(msg.sender, price);
        _settle(key, licensee, msg.sender, price);
    }

    /// @notice Buy a licence with one signed EIP-3009 authorization, the payment form x402 uses on X Layer. The
    /// authorization's nonce must be keccak256(abi.encode(key, licensee, salt)), which binds the signature to this
    /// purchase: nobody can replay it for another song or another licensee.
    function licenseWithAuthorization(
        bytes32 key,
        address licensee,
        bytes32 salt,
        address from,
        uint256 validAfter,
        uint256 validBefore,
        uint8 v,
        bytes32 r_,
        bytes32 s_
    ) external nonReentrant {
        Release storage r = releases[key];
        if (!r.exists) revert NotReleased();
        bytes32 nonce = keccak256(abi.encode(key, licensee, salt));
        token.receiveWithAuthorization(from, address(this), r.price, validAfter, validBefore, nonce, v, r_, s_);
        _settle(key, licensee, from, r.price);
    }

    /// @notice Withdraw everything credited to you.
    function withdraw() external nonReentrant {
        uint256 amount = owed[msg.sender];
        if (amount == 0) revert NothingOwed();
        owed[msg.sender] = 0;
        totalOwed -= amount;
        if (!token.transfer(msg.sender, amount)) revert TransferFailed();
        emit Withdrawn(msg.sender, amount);
    }

    function parentsOf(bytes32 key) external view returns (bytes32[] memory) {
        return _parents[key];
    }

    function isLicensed(address cpu, uint256 id, address licensee) external view returns (bool) {
        return licensed[keyOf(cpu, id)][licensee];
    }

    /// @notice The (processor, id) of every REF record in a TAP-02 netlist, in record order.
    function refTargets(bytes memory nl) public pure returns (address[] memory cpus, uint64[] memory ids) {
        uint256 n = 0;
        uint256 p = 0;
        uint256 len = nl.length;
        // First pass: count REF records and check that every record is complete.
        while (p < len) {
            uint8 op = uint8(nl[p]);
            if (op == 0x00) {
                p += 7;
            } else if (op == 0x01) {
                p += 4;
            } else if (op == 0x02) {
                if (p + 31 > len) revert MalformedNetlist(p);
                p += 31 + 3 * uint256(uint8(nl[p + 29]));
                n++;
            } else {
                revert MalformedNetlist(p);
            }
            if (p > len) revert MalformedNetlist(p);
        }
        cpus = new address[](n);
        ids = new uint64[](n);
        p = 0;
        uint256 k = 0;
        while (p < len) {
            uint8 op = uint8(nl[p]);
            if (op == 0x00) {
                p += 7;
            } else if (op == 0x01) {
                p += 4;
            } else {
                address c;
                uint64 id;
                assembly {
                    let w := mload(add(add(nl, 0x20), add(p, 1)))
                    c := shr(96, w)
                    let w2 := mload(add(add(nl, 0x20), add(p, 21)))
                    id := shr(192, w2)
                }
                cpus[k] = c;
                ids[k] = id;
                k++;
                p += 31 + 3 * uint256(uint8(nl[p + 29]));
            }
        }
    }

    function _settle(bytes32 key, address licensee, address payer, uint256 amount) internal {
        licensed[key][licensee] = true;
        emit Licensed(key, licensee, payer, amount);
        if (amount == 0) return;
        uint256 fee = (amount * feeBps) / MAX_BPS;
        if (fee > 0) _credit(key, treasury, fee);
        _split(key, amount - fee, 0);
    }

    function _split(bytes32 key, uint256 amount, uint256 depth) internal {
        Release storage r = releases[key];
        address holder = _holder(r);
        bytes32[] storage parents = _parents[key];
        uint256 np = parents.length;
        if (np == 0 || depth >= MAX_DEPTH || r.upstreamBps == 0) {
            _credit(key, holder, amount);
            return;
        }
        uint256 each = (amount * r.upstreamBps) / MAX_BPS / np;
        for (uint256 i = 0; i < np; i++) {
            _split(parents[i], each, depth + 1);
        }
        _credit(key, holder, amount - each * np);
    }

    /// @dev The circuit's current owner; the treasury if the processor no longer reports one.
    function _holder(Release storage r) internal view returns (address) {
        try IProcessor(r.cpu).ownerOf(r.id) returns (address o) {
            return o == address(0) ? treasury : o;
        } catch {
            return treasury;
        }
    }

    function _credit(bytes32 key, address payee, uint256 amount) internal {
        if (amount == 0) return;
        owed[payee] += amount;
        totalOwed += amount;
        emit Credited(key, payee, amount);
    }

    function _pull(address from, uint256 amount) internal {
        (bool ok, bytes memory ret) =
            address(token).call(abi.encodeCall(IERC20Auth.transferFrom, (from, address(this), amount)));
        if (!ok || (ret.length > 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function _contains(bytes32[] storage list, bytes32 k) internal view returns (bool) {
        for (uint256 i = 0; i < list.length; i++) {
            if (list[i] == k) return true;
        }
        return false;
    }
}
