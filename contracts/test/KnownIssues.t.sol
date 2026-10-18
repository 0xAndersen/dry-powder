// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console2} from "forge-std/console2.sol";
import {PerpEngine} from "../src/PerpEngine.sol";
import {OpenParams} from "../src/Types.sol";
import {Base} from "./Base.t.sol";

/// @notice Proof-of-concept tests for findings that are still OPEN in v2. Each test PASSES while the issue
///         exists: they document accepted or unresolved risks, most of them consequences of the economic model
///         rather than coding errors. M-01, L-01, L-02 and L-06 are carried over from the v1 review (H-01,
///         M-02..M-05 and L-05 are fixed; see Regressions.t.sol). The N-series was found while reviewing v2.
contract KnownIssuesTest is Base {
    // ───────────────────────── M-01 (open, now bounded) ─────────────────────────
    /// Losses are capped at margin and there is no insurance / ADL, so a 100x straddle is still a free option on
    /// any move that outruns liquidators (price gap, FX weekend re-open, feed outage). v2 caps profit at
    /// `maxProfitMultiple` (10x) of margin, which bounds the payoff of one pair at about 9x its margin however
    /// large the gap, but does nothing for ordinary gaps of a few percent.
    function test_M01_hundredXStraddleProfitsFromGap() public {
        uint256 attackerBefore = _bal(alice) + _bal(bob);
        uint256 navBefore = vault.totalAssets();

        _open(alice, BTC, true, 1_000e6, 100_000e6);
        _open(bob, BTC, false, 1_000e6, 100_000e6);

        _setBtc(103_000); // 3% gap between two consecutive usable prices

        vm.prank(alice);
        _liquidate(bob); // self-liquidate the loser, pocket the 2% keeper fee
        _close(alice, BTC);

        uint256 attackerAfter = _bal(alice) + _bal(bob);
        console2.log("straddle profit on 2,000 USDC margin", (attackerAfter - attackerBefore) / 1e6);
        assertGt(attackerAfter, attackerBefore + 1_800e6);
        assertLt(vault.totalAssets(), navBefore - 1_800e6);
    }

    /// The bound added in v2: with a 30% gap the same straddle would have made ~28,800 in v1; now the winning
    /// leg stops at 10x its margin.
    function test_M01_straddlePayoffIsBoundedByTheProfitCap() public {
        uint256 attackerBefore = _bal(alice) + _bal(bob);
        _open(alice, BTC, true, 1_000e6, 100_000e6);
        _open(bob, BTC, false, 1_000e6, 100_000e6);
        _setBtc(130_000);
        vm.prank(alice);
        _liquidate(bob);
        _close(alice, BTC);
        uint256 profit = _bal(alice) + _bal(bob) - attackerBefore;
        console2.log("straddle profit on a 30% gap", profit / 1e6);
        assertGt(profit, 8_500e6);
        assertLt(profit, 9_000e6); // 10,000 cap - 1,000 lost leg - fees + 20 keeper fee
    }

    // ───────────────────────── L-01 (open) ─────────────────────────
    /// A publishTime up to maxPriceAge in the FUTURE is accepted, so the same price stays usable for
    /// 2 * maxPriceAge seconds of chain time, doubling the latency window. (PublisherOracle limits how far
    /// ahead a publisher may stamp to 2 seconds; real Pyth does not.)
    function test_L01_futurePublishTimeDoublesStalenessWindow() public {
        skip(10);
        uint64 t = uint64(vm.getBlockTimestamp());
        pyth.updatePriceFeeds{value: PYTH_FEE}(_updateData(BTC, 100_000e8, 0, -8, t + 3));
        assertEq(engine.getPrice(BTC).publishTime, t + 3);
        skip(6); // six seconds after it was first usable
        _open(alice, BTC, true, 1_000e6, 10_000e6); // still accepted with maxPriceAge = 3
        assertEq(engine.getPosition(alice, BTC).entryPrice, 100_000e18);
    }

    // ───────────────────────── L-02 (open) ─────────────────────────
    /// maxConfBps (owner may set up to 500) is not tied to leverage. Opens fill at ask, liquidations test at mid,
    /// so with conf >= ~0.9% a 100x position is liquidatable in the block it is opened.
    function test_L02_wideConfidenceMakesHighLeverageOpenInstantlyLiquidatable() public {
        vm.prank(owner);
        engine.setRiskParams(3, 100, 30_000, 5e6);
        _setPrice(BTC, 100_000e8, 1_000e8, -8); // 1% confidence, allowed

        uint256 before = _bal(alice);
        _open(alice, BTC, true, 10_000e6, 1_000_000e6);
        vm.prank(bob);
        assertEq(_liquidate(alice), 1); // same block, price unchanged
        assertGt(before - _bal(alice), 10_000e6, "entire margin plus open fee lost at an unchanged price");
    }

    // ───────────────────────── L-06 (open) ─────────────────────────
    /// The skew surcharge is priced on the end-state skew of each trade, so splitting one trade across
    /// accounts is cheaper than doing it in one piece.
    function test_L06_skewFeeIsReducedBySplittingAcrossAccounts() public {
        uint256 whole = engine.quoteOpenFee(BTC, 1_000_000e6, true, type(uint256).max / 1e5);
        uint256 first = engine.quoteOpenFee(BTC, 500_000e6, true, type(uint256).max / 1e5);
        _open(alice, BTC, true, 50_000e6, 500_000e6);
        uint256 second = engine.quoteOpenFee(BTC, 500_000e6, true, type(uint256).max / 1e5);
        assertEq(whole, 1_500e6);
        assertEq(first + second, 1_250e6);
    }

    // ───────────────────────── N-01 (new in v2) ─────────────────────────
    /// The staker share is taken at epoch boundaries as (value per share - mark) * CURRENT supply. An LP who
    /// redeems just before `settleEpoch` leaves with his full gain and pays none of the 15%; he can re-deposit
    /// right after. (`settleEpoch` is callable by anyone, so he can even do all three in one transaction.)
    function test_N01_lpAvoidsTheStakerShareByExitingBeforeSettlement() public {
        _stake(bob, 1_000e18);
        vm.prank(carol);
        vault.deposit(1_000_000e6, carol); // two equal LPs
        _feeIncome(200_000e6); // the house earns 10% this epoch
        skip(EPOCH);

        // Had both stayed, stakers would get 15% of 200k = 30k and each LP would keep 1,085,000.
        vm.startPrank(lp);
        uint256 out = vault.redeem(vault.balanceOf(lp), lp, lp);
        uint256 toStakers = vault.settleEpoch();
        vault.deposit(out, lp);
        vm.stopPrank();

        assertEq(out, 1_100_000e6 - 1); // his full 10%
        assertEq(toStakers, 15_000e6); // stakers were paid on carol's half only
        assertApproxEqAbs(vault.convertToAssets(vault.balanceOf(lp)), 1_100_000e6, 2);
        assertApproxEqAbs(vault.convertToAssets(vault.balanceOf(carol)), 1_085_000e6, 2);
    }

    // ───────────────────────── N-02 (new in v2, reduced) ─────────────────────────
    /// The mirror image: a deposit made before `settleEpoch` joins a pool that still owes stakers 15% of the
    /// epoch's gain, and that amount is taken from the pool, i.e. from every share, at settlement. The newcomer
    /// therefore pays a pro-rata part of the fee on a gain that was made before it arrived, and the earlier
    /// holders pay that much less. (Before the fix in `HouseVault._deposit` it was worse: the gain was
    /// re-counted on the new shares, stakers got 30,000 here and the newcomer lost 15,000.)
    function test_N02_depositBeforeSettlementSharesTheFeeOnEarlierGains() public {
        _stake(bob, 1_000e18);
        _feeIncome(100_000e6); // the house (one LP, 1M) earns 100k: 15k is due to stakers
        skip(EPOCH);

        usdc.mint(carol, 100_000e6);
        vm.prank(carol);
        vault.deposit(1_100_000e6, carol); // arrives before anyone has settled the epoch
        uint256 toStakers = vault.settleEpoch();

        assertEq(toStakers, 15_000e6); // the right total ...
        // ... but half of it came out of carol's shares: she is 7,500 down within one transaction, and the
        // LP who made the whole gain paid 7.5% on it instead of 15%.
        assertApproxEqAbs(vault.convertToAssets(vault.balanceOf(carol)), 1_092_500e6, 2);
        assertApproxEqAbs(vault.convertToAssets(vault.balanceOf(lp)), 1_092_500e6, 2);
    }

    // ───────────────────────── N-03 (new in v2) ─────────────────────────
    /// `unrealizedTraderPnl` nets losses at face value although a loss can only ever be collected up to the
    /// position's margin. Between a price gap and the liquidation of the losing side, an un-collectable loss
    /// hides a real unrealised profit, the mark shows nothing owed, and an LP can still leave at the stale price
    /// (the v1 M-03 exit, narrowed to this window). Deposits made in the opposite situation overpay.
    function test_N03_uncollectableLossMasksAWinnerInTheMark() public {
        _flatFees();
        vm.prank(carol);
        vault.deposit(1_000_000e6, carol);
        skip(LOCK);
        _refreshAll();
        _open(alice, BTC, true, 10_000e6, 1_000_000e6); // 100x long
        _open(bob, BTC, false, 10_000e6, 1_000_000e6); // 100x short
        uint256 realised = vault.totalHouseBalance();

        _setBtc(108_000); // 8% gap: alice is owed 80k, bob can pay at most his 10k margin
        assertEq(engine.unrealizedTraderPnl(), 0); // +80k and -80k
        assertEq(vault.exitValue(), realised); // the house is really about 70k worse off than this

        // lp leaves at the unmarked price ...
        uint256 lpBefore = _bal(lp);
        vm.startPrank(lp);
        vault.redeem(vault.balanceOf(lp), lp, lp);
        vm.stopPrank();
        uint256 lpOut = _bal(lp) - lpBefore;
        assertApproxEqAbs(lpOut, realised / 2, 1);

        // ... then the book is cleaned up, and carol alone carries the loss.
        vm.prank(keeper);
        _liquidate(bob);
        _close(alice, BTC);
        uint256 carolValue = vault.convertToAssets(vault.balanceOf(carol));
        console2.log("leaver took    ", lpOut / 1e6);
        console2.log("stayer is left ", carolValue / 1e6);
        assertLt(carolValue + 69_000e6, lpOut);
    }

    // ───────────────────────── N-04 (new in v2) ─────────────────────────
    /// A market whose oracle price is momentarily unusable (invalid, or confidence wider than `maxConfBps`) is
    /// left out of `unrealizedTraderPnl` altogether, i.e. marked at zero PnL. While that lasts the vault prices
    /// itself as if that market's winners did not exist: LPs can exit ahead of them, and an epoch settled in
    /// that moment pays stakers on gains that are owed to traders.
    function test_N04_marketWithoutUsablePriceIsMarkedAtZero() public {
        _flatFees();
        _stake(carol, 1_000e18);
        _open(alice, BTC, true, 10_000e6, 100_000e6);
        _open(bob, BTC, false, 10_000e6, 100_000e6);
        _setBtc(105_000);
        _close(bob, BTC); // the loser realises 5k into the house; alice's +5k stays open
        uint256 realised = vault.totalHouseBalance();
        assertEq(vault.exitValue(), realised - 5_000e6);

        _setPrice(BTC, 105_000e8, 700e8, -8); // confidence blows out to 0.67%
        assertEq(engine.unrealizedTraderPnl(), 0);
        assertEq(vault.exitValue(), realised);
        skip(EPOCH);
        uint256 toStakers = vault.settleEpoch();
        console2.log("paid to stakers on 5k that is owed to a trader", toStakers / 1e6);
        assertEq(toStakers, 772.5e6); // 15% of (5,000 + 150 of fees); without the blind spot: 22.5
    }

    // ───────────────────────── N-05 (new in v2, residue of M-02) ─────────────────────────
    /// The reserve nets long against short within a market only. Offsetting exposure in two markets on the
    /// same underlying (the BTC perpetual and the BTC future, or a triangle through the ETH/BTC cross) is
    /// delta-neutral for the attacker and still reserves both legs, so LP withdrawals can again be frozen.
    /// Unlike v1 this is no longer free: each leg is the whole skew of its market and pays full funding
    /// (to the vault), about 0.14% of notional a day at the default rate.
    function test_N05_crossMarketHedgeStillPinsTheReserve() public {
        skip(LOCK);
        _refreshAll();
        uint256 before = _bal(alice) + _bal(bob);
        _open(alice, BTC, true, 150_000e6, 1_500_000e6);
        _open(bob, FUT, false, 150_000e6, 1_500_000e6);
        assertEq(engine.reservedLiquidity(), 1_000_000e6);
        console2.log("LP withdrawable of ~1,004,500", vault.maxWithdraw(lp) / 1e6);
        assertLt(vault.maxWithdraw(lp), 5_000e6);

        // A week later, at an unchanged price, it has cost the attacker funding on both legs.
        skip(7 days);
        _refreshAll();
        _close(alice, BTC);
        _close(bob, FUT);
        uint256 cost = before - (_bal(alice) + _bal(bob));
        console2.log("cost of freezing a 1M vault for a week", cost / 1e6);
        assertGt(cost, 30_000e6);
    }

    // ───────────────────────── N-06 (new in v2) ─────────────────────────
    /// Nothing forces a dated market to be settled at expiry. Until someone calls `settleMarket` its positions
    /// keep trading against the live price with funding switched off, and the settlement price is whatever
    /// the feed says at the moment a caller chooses, however long after expiry.
    function test_N06_expiredUnsettledFutureCarriesNoFundingAndSettlesWhenACallerChooses() public {
        _open(alice, FUT, true, 50_000e6, 500_000e6);
        vm.warp(EXPIRY);
        int256 indexAtExpiry = engine.currentFundingIndex(FUT);
        assertGt(indexAtExpiry, 0);

        vm.warp(EXPIRY + 90 days); // a quarter of a year past expiry, still unsettled
        assertEq(engine.currentFundingIndex(FUT), indexAtExpiry); // a one-sided 500k book carried for free
        _publish(BTC, 125_000e8, 0, -8);
        vm.prank(alice);
        engine.settleMarket(FUT, _noBytes()); // the holder picks the moment
        assertEq(_market(FUT).settlementPrice, 125_000e18);
    }

    // ───────────────────────── N-07 (new in v2, the staking side of the old H-01) ─────────────────────────
    /// DRY is still minted on GROSS losses: 100 per USDC a position loses, whether or not the same person
    /// holds the offsetting winner. A delta-neutral pair therefore manufactures DRY for the price of its
    /// trading fees. It no longer drains LPs (H-01 is fixed), but it lets a farmer out-stake the traders who
    /// really lost money and collect most of the 15% performance stream that was meant for them.
    function test_N07_houseIsFarmedWithHedgedPairsForTheCostOfFees() public {
        _flatFees();
        // An honest trader really loses 1,000 USDC and stakes the 100,000 DRY that earned her.
        _open(carol, ETH, true, 2_000e6, 10_000e6);
        _setEth(3_600);
        _close(carol, ETH);
        vm.prank(carol);
        house.stake(100_000e18);

        // The farmer runs one hedged cycle: 1M a side, an 8% move.
        uint256 before = _bal(alice) + _bal(bob);
        _open(alice, BTC, true, 100_000e6, 1_000_000e6);
        _open(bob, BTC, false, 100_000e6, 1_000_000e6);
        _setBtc(108_000);
        _close(alice, BTC);
        _close(bob, BTC);
        uint256 cost = before - (_bal(alice) + _bal(bob));
        assertEq(cost, 2_000e6); // four fees of 500
        assertEq(house.balanceOf(bob), 8_000_000e18); // 80x the honest staker's stake, for 2x her loss
        vm.prank(bob);
        house.stake(8_000_000e18);

        // From here on he takes 98.8% of everything stakers are paid.
        _feeIncome(100_000e6);
        skip(EPOCH);
        uint256 toStakers = vault.settleEpoch();
        skip(STREAM);
        assertApproxEqAbs(house.earned(bob), (toStakers * 80) / 81, 2);
        assertGt(house.earned(bob), cost * 7);
    }
}
