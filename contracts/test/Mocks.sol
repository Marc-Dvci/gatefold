// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IProcessor, IProcessorFactory} from "../src/GatefoldRecords.sol";

/// A processor stand-in: circuits with owners and netlists, as the TapeOut processor exposes them.
contract MockProcessor is IProcessor {
    mapping(uint256 => address) public owners;
    mapping(uint256 => bytes) internal nets;
    mapping(uint256 => uint32) internal nIns;
    bool public brokenOwner;

    function set(uint256 id, address owner, bytes memory nl, uint32 nIn) external {
        owners[id] = owner;
        nets[id] = nl;
        nIns[id] = nIn;
    }

    function transfer(uint256 id, address to) external {
        owners[id] = to;
    }

    function breakOwner(bool b) external {
        brokenOwner = b;
    }

    function ownerOf(uint256 id) external view returns (address) {
        require(!brokenOwner, "no owner");
        address o = owners[id];
        require(o != address(0), "ERC721NonexistentToken");
        return o;
    }

    function netlist(uint256 id) external view returns (bytes memory) {
        return nets[id];
    }

    function circuitInfo(uint256 id) external view returns (uint32, uint32, uint32, uint32) {
        return (nIns[id], 1, 0, 0);
    }
}

contract MockFactory is IProcessorFactory {
    mapping(address => bool) public cpus;

    function add(address c) external {
        cpus[c] = true;
    }

    function isCPU(address cpu) external view returns (bool) {
        return cpus[cpu];
    }
}

/// An ERC-20 with EIP-3009 receiveWithAuthorization, checked with a real EIP-712 signature, as USD₮0 does.
contract MockUSDT0 {
    string public constant name = "USD\xe2\x82\xae0";
    string public constant version = "1";
    uint8 public constant decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => mapping(bytes32 => bool)) public authorizationState;
    bytes32 public immutable DOMAIN_SEPARATOR;
    bytes32 public constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    constructor() {
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name)),
                keccak256(bytes(version)),
                block.chainid,
                address(this)
            )
        );
    }

    function mint(address to, uint256 v) external {
        balanceOf[to] += v;
    }

    function approve(address s, uint256 v) external returns (bool) {
        allowance[msg.sender][s] = v;
        return true;
    }

    function transfer(address to, uint256 v) external returns (bool) {
        _move(msg.sender, to, v);
        return true;
    }

    function transferFrom(address from, address to, uint256 v) external returns (bool) {
        require(allowance[from][msg.sender] >= v, "allowance");
        allowance[from][msg.sender] -= v;
        _move(from, to, v);
        return true;
    }

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
    ) external {
        require(to == msg.sender, "caller must be the payee");
        require(block.timestamp > validAfter && block.timestamp < validBefore, "authorization not valid now");
        require(!authorizationState[from][nonce], "authorization used");
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                DOMAIN_SEPARATOR,
                keccak256(
                    abi.encode(RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce)
                )
            )
        );
        require(ecrecover(digest, v, r, s) == from, "invalid signature");
        authorizationState[from][nonce] = true;
        _move(from, to, value);
    }

    function _move(address from, address to, uint256 v) internal {
        require(balanceOf[from] >= v, "balance");
        balanceOf[from] -= v;
        balanceOf[to] += v;
    }
}
