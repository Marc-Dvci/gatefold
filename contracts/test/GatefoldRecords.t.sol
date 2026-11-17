// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {GatefoldRecords, IERC20Auth, IProcessorFactory} from "../src/GatefoldRecords.sol";
import {MockFactory, MockProcessor, MockUSDT0} from "./Mocks.sol";

contract GatefoldRecordsTest is Test {
    GatefoldRecords rec;
    MockUSDT0 usd;
    MockFactory fac;
    MockProcessor cpu;
    address treasury = address(0x7EA5);
    address maker = address(0xA11CE); // instrument maker
    address artist = address(0xB0B); // song writer
    address remixer = address(0xC0DE);
    uint256 buyerKey = 0xB0E7;
    address buyer;
    address game = address(0x6A3E);

    uint256 constant PRICE = 10_000_000; // 10 USD₮0

    function setUp() public {
        usd = new MockUSDT0();
        fac = new MockFactory();
        cpu = new MockProcessor();
        fac.add(address(cpu));
        rec = new GatefoldRecords(IERC20Auth(address(usd)), IProcessorFactory(address(fac)), treasury, 250);
        buyer = vm.addr(buyerKey);
        usd.mint(buyer, 1_000_000_000);
        // Instruments 1..3 by the maker: plain gates, no REF.
        for (uint256 i = 1; i <= 3; i++) {
            cpu.set(i, maker, hex"00000002000003", 2);
        }
    }

    function refRecord(address c, uint64 id, uint8 nIns) internal pure returns (bytes memory r) {
        r = abi.encodePacked(uint8(2), c, id, nIns, uint8(4));
        for (uint256 i = 0; i < nIns; i++) {
            r = abi.encodePacked(r, uint24(2));
        }
    }

    /// A song netlist: a NAND, then REFs to the given instrument ids on `cpu`, then a LATCH.
    function songNetlist(uint64[] memory ids) internal view returns (bytes memory nl) {
        nl = hex"00000002000003";
        for (uint256 i = 0; i < ids.length; i++) {
            nl = abi.encodePacked(nl, refRecord(address(cpu), ids[i], 3));
        }
        nl = abi.encodePacked(nl, hex"01000002");
    }

    function releaseInstruments(uint128 price, uint16 up) internal {
        vm.startPrank(maker);
        for (uint256 i = 1; i <= 3; i++) {
            rec.release(address(cpu), i, price, up, "instrument");
        }
        vm.stopPrank();
    }

    function releaseSong(uint256 id, uint16 up) internal returns (bytes32) {
        uint64[] memory ids = new uint64[](3);
        ids[0] = 1;
        ids[1] = 2;
        ids[2] = 3;
        cpu.set(id, artist, songNetlist(ids), 3);
        vm.prank(artist);
        return rec.release(address(cpu), id, uint128(PRICE), up, "song");
    }

    function test_release_records_released_REF_targets_as_parents() public {
        releaseInstruments(0, 0);
        bytes32 key = releaseSong(10, 3_000);
        bytes32[] memory parents = rec.parentsOf(key);
        assertEq(parents.length, 3);
        assertEq(parents[0], rec.keyOf(address(cpu), 1));
        assertEq(parents[2], rec.keyOf(address(cpu), 3));
    }

    function test_unreleased_REF_targets_are_not_parents() public {
        vm.prank(maker);
        rec.release(address(cpu), 2, 0, 0, "");
        bytes32 key = releaseSong(10, 3_000);
        bytes32[] memory parents = rec.parentsOf(key);
        assertEq(parents.length, 1);
        assertEq(parents[0], rec.keyOf(address(cpu), 2));
    }

    function test_a_REF_repeated_in_the_netlist_is_one_parent() public {
        releaseInstruments(0, 0);
        uint64[] memory ids = new uint64[](4);
        ids[0] = 1;
        ids[1] = 1;
        ids[2] = 2;
        ids[3] = 1;
        cpu.set(11, artist, songNetlist(ids), 3);
        vm.prank(artist);
        bytes32 key = rec.release(address(cpu), 11, 1, 0, "");
        assertEq(rec.parentsOf(key).length, 2);
    }

    function test_only_the_circuit_owner_can_release() public {
        vm.prank(artist);
        vm.expectRevert(GatefoldRecords.NotCircuitOwner.selector);
        rec.release(address(cpu), 1, 1, 0, "");
    }

    function test_a_processor_the_factory_does_not_know_is_refused() public {
        MockProcessor fake = new MockProcessor();
        fake.set(1, maker, hex"00000002000003", 2);
        vm.prank(maker);
        vm.expectRevert(abi.encodeWithSelector(GatefoldRecords.NotAProcessor.selector, address(fake)));
        rec.release(address(fake), 1, 1, 0, "");
    }

    function test_an_id_beyond_u64_is_refused() public {
        uint256 big = uint256(type(uint64).max) + 1;
        cpu.set(big, maker, hex"00000002000003", 2);
        vm.prank(maker);
        vm.expectRevert(GatefoldRecords.IdTooLarge.selector);
        rec.release(address(cpu), big, 1, 0, "");
    }

    function test_a_release_happens_once() public {
        releaseInstruments(0, 0);
        vm.prank(maker);
        vm.expectRevert(GatefoldRecords.AlreadyReleased.selector);
        rec.release(address(cpu), 1, 1, 0, "");
    }

    function test_an_upstream_share_above_100_percent_is_refused() public {
        vm.prank(maker);
        vm.expectRevert(GatefoldRecords.BadShare.selector);
        rec.release(address(cpu), 1, 1, 10_001, "");
    }

    function test_a_fee_above_10_percent_is_refused_at_deploy() public {
        vm.expectRevert(GatefoldRecords.BadShare.selector);
        new GatefoldRecords(IERC20Auth(address(usd)), IProcessorFactory(address(fac)), treasury, 1_001);
    }

    function test_licence_splits_fee_upstream_and_owner() public {
        releaseInstruments(0, 0);
        bytes32 key = releaseSong(10, 3_000); // 30 % upstream
        vm.startPrank(buyer);
        usd.approve(address(rec), PRICE);
        rec.license(key, game);
        vm.stopPrank();
        uint256 fee = (PRICE * 250) / 10_000; // 2.5 %
        uint256 rest = PRICE - fee;
        uint256 each = (rest * 3_000) / 10_000 / 3;
        assertEq(rec.owed(treasury), fee);
        assertEq(rec.owed(maker), each * 3);
        assertEq(rec.owed(artist), rest - each * 3);
        assertEq(rec.totalOwed(), PRICE);
        assertEq(usd.balanceOf(address(rec)), PRICE);
        assertTrue(rec.isLicensed(address(cpu), 10, game));
        assertFalse(rec.isLicensed(address(cpu), 10, buyer));
    }

    function test_a_remix_pays_the_song_and_through_it_the_instruments() public {
        releaseInstruments(0, 0);
        releaseSong(10, 5_000);
        uint64[] memory ids = new uint64[](1);
        ids[0] = 10;
        cpu.set(20, remixer, songNetlist(ids), 3);
        vm.prank(remixer);
        bytes32 rk = rec.release(address(cpu), 20, uint128(PRICE), 4_000, "remix");
        vm.startPrank(buyer);
        usd.approve(address(rec), PRICE);
        rec.license(rk, game);
        vm.stopPrank();
        uint256 rest = PRICE - (PRICE * 250) / 10_000;
        uint256 toSong = (rest * 4_000) / 10_000;
        uint256 each = (toSong * 5_000) / 10_000 / 3;
        assertEq(rec.owed(remixer), rest - toSong);
        assertEq(rec.owed(artist), toSong - each * 3);
        assertEq(rec.owed(maker), each * 3);
        assertEq(rec.totalOwed(), PRICE);
    }

    function test_rights_follow_the_circuit_NFT() public {
        releaseInstruments(0, 0);
        bytes32 key = releaseSong(10, 0);
        cpu.transfer(10, remixer);
        vm.startPrank(buyer);
        usd.approve(address(rec), PRICE);
        rec.license(key, game);
        vm.stopPrank();
        assertEq(rec.owed(artist), 0);
        assertGt(rec.owed(remixer), 0);
    }

    function test_only_the_current_owner_sets_the_price() public {
        releaseInstruments(0, 0);
        bytes32 key = releaseSong(10, 0);
        vm.prank(maker);
        vm.expectRevert(GatefoldRecords.NotCircuitOwner.selector);
        rec.setPrice(key, 1);
        vm.prank(artist);
        rec.setPrice(key, 42);
        (,, uint128 price,,) = rec.releases(key);
        assertEq(price, 42);
    }

    function test_withdraw_pays_out_once() public {
        releaseInstruments(0, 0);
        bytes32 key = releaseSong(10, 3_000);
        vm.startPrank(buyer);
        usd.approve(address(rec), PRICE);
        rec.license(key, game);
        vm.stopPrank();
        uint256 due = rec.owed(artist);
        vm.prank(artist);
        rec.withdraw();
        assertEq(usd.balanceOf(artist), due);
        assertEq(rec.owed(artist), 0);
        vm.prank(artist);
        vm.expectRevert(GatefoldRecords.NothingOwed.selector);
        rec.withdraw();
    }

    function test_a_licence_without_allowance_reverts_and_records_nothing() public {
        releaseInstruments(0, 0);
        bytes32 key = releaseSong(10, 3_000);
        vm.prank(buyer);
        vm.expectRevert(GatefoldRecords.TransferFailed.selector);
        rec.license(key, game);
        assertFalse(rec.licensed(key, game));
        assertEq(rec.totalOwed(), 0);
    }

    function test_licensing_an_unreleased_circuit_reverts() public {
        bytes32 key = rec.keyOf(address(cpu), 99);
        vm.expectRevert(GatefoldRecords.NotReleased.selector);
        rec.license(key, game);
    }

    function test_a_free_release_records_the_licence_without_payment() public {
        vm.prank(maker);
        bytes32 key = rec.release(address(cpu), 1, 0, 0, "");
        rec.license(key, game);
        assertTrue(rec.licensed(key, game));
        assertEq(rec.totalOwed(), 0);
    }

    function test_a_circuit_without_owner_credits_the_treasury() public {
        releaseInstruments(0, 0);
        bytes32 key = releaseSong(10, 0);
        vm.startPrank(buyer);
        usd.approve(address(rec), PRICE);
        cpu.breakOwner(true);
        rec.license(key, game);
        vm.stopPrank();
        assertEq(rec.owed(treasury), PRICE);
    }

    // EIP-3009: one signature pays for one licence.

    function signReceive(bytes32 nonce, uint256 value) internal view returns (uint8 v, bytes32 r, bytes32 s) {
        bytes32 structHash = keccak256(
            abi.encode(
                usd.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(),
                buyer,
                address(rec),
                value,
                0,
                block.timestamp + 1 hours,
                nonce
            )
        );
        return vm.sign(buyerKey, keccak256(abi.encodePacked("\x19\x01", usd.DOMAIN_SEPARATOR(), structHash)));
    }

    function test_licence_with_a_signed_authorization() public {
        releaseInstruments(0, 0);
        bytes32 key = releaseSong(10, 3_000);
        bytes32 salt = keccak256("order-1");
        (uint8 v, bytes32 r, bytes32 s) = signReceive(keccak256(abi.encode(key, game, salt)), PRICE);
        vm.warp(block.timestamp + 1);
        rec.licenseWithAuthorization(key, game, salt, buyer, 0, block.timestamp + 1 hours - 1, v, r, s);
        assertTrue(rec.licensed(key, game));
        assertEq(rec.totalOwed(), PRICE);
        assertEq(usd.balanceOf(buyer), 1_000_000_000 - PRICE);
    }

    function test_a_signed_authorization_cannot_be_redirected_to_another_licensee() public {
        releaseInstruments(0, 0);
        bytes32 key = releaseSong(10, 3_000);
        bytes32 salt = keccak256("order-1");
        uint256 before = block.timestamp;
        (uint8 v, bytes32 r, bytes32 s) = signReceive(keccak256(abi.encode(key, game, salt)), PRICE);
        vm.warp(before + 1);
        vm.expectRevert(bytes("invalid signature"));
        rec.licenseWithAuthorization(key, remixer, salt, buyer, 0, before + 1 hours, v, r, s);
    }

    function test_a_signed_authorization_cannot_be_replayed() public {
        releaseInstruments(0, 0);
        bytes32 key = releaseSong(10, 3_000);
        bytes32 salt = keccak256("order-1");
        uint256 before = block.timestamp;
        (uint8 v, bytes32 r, bytes32 s) = signReceive(keccak256(abi.encode(key, game, salt)), PRICE);
        vm.warp(before + 1);
        rec.licenseWithAuthorization(key, game, salt, buyer, 0, before + 1 hours, v, r, s);
        vm.expectRevert(bytes("authorization used"));
        rec.licenseWithAuthorization(key, game, salt, buyer, 0, before + 1 hours, v, r, s);
    }

    // Netlist parsing.

    function test_refTargets_reads_processor_and_id_of_each_REF() public view {
        bytes memory nl = abi.encodePacked(
            hex"00000002000003", refRecord(address(0xBEEF), 7, 2), hex"01000002", refRecord(address(cpu), 2 ** 40, 0)
        );
        (address[] memory cpus, uint64[] memory ids) = rec.refTargets(nl);
        assertEq(cpus.length, 2);
        assertEq(cpus[0], address(0xBEEF));
        assertEq(ids[0], 7);
        assertEq(cpus[1], address(cpu));
        assertEq(ids[1], 2 ** 40);
    }

    function test_refTargets_refuses_an_unknown_opcode() public {
        vm.expectRevert(abi.encodeWithSelector(GatefoldRecords.MalformedNetlist.selector, 7));
        rec.refTargets(hex"0000000200000303");
    }

    function test_refTargets_refuses_a_truncated_REF() public {
        vm.expectRevert(abi.encodeWithSelector(GatefoldRecords.MalformedNetlist.selector, 0));
        rec.refTargets(hex"02000000");
    }

    function test_refTargets_refuses_a_truncated_gate() public {
        vm.expectRevert(abi.encodeWithSelector(GatefoldRecords.MalformedNetlist.selector, 7));
        rec.refTargets(hex"000000");
    }

    // Properties.

    /// Every unit paid is credited to someone, whatever the price, fee and shares.
    function testFuzz_credits_add_up_to_the_price(uint128 price, uint16 songUp, uint16 instUp, uint8 nRefs) public {
        price = uint128(bound(price, 0, 1e15));
        songUp = uint16(bound(songUp, 0, 10_000));
        instUp = uint16(bound(instUp, 0, 10_000));
        nRefs = uint8(bound(nRefs, 0, 12));
        releaseInstruments(1, instUp);
        uint64[] memory ids = new uint64[](nRefs);
        for (uint256 i = 0; i < nRefs; i++) {
            ids[i] = uint64(1 + (i % 3));
        }
        cpu.set(50, artist, songNetlist(ids), 3);
        vm.prank(artist);
        bytes32 key = rec.release(address(cpu), 50, price, songUp, "");
        usd.mint(buyer, price);
        vm.startPrank(buyer);
        usd.approve(address(rec), price);
        rec.license(key, game);
        vm.stopPrank();
        assertEq(rec.totalOwed(), price);
        assertEq(rec.owed(treasury) + rec.owed(maker) + rec.owed(artist), price);
        assertEq(usd.balanceOf(address(rec)), price);
    }

    /// Parsing never reads past the end: random bytes either parse or revert with MalformedNetlist.
    function testFuzz_refTargets_never_overreads(bytes memory nl) public view {
        try rec.refTargets(nl) returns (address[] memory cpus, uint64[] memory ids) {
            assertEq(cpus.length, ids.length);
        } catch (bytes memory err) {
            assertEq(bytes4(err), GatefoldRecords.MalformedNetlist.selector);
        }
    }
}
