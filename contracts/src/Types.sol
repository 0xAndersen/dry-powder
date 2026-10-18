// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice A trader's position in one market. `priceId` is the market id; for a plain perpetual it equals the
///         Pyth feed id, for cross and dated markets it is a separate identifier.
struct Position {
    uint256 margin; // USDC collateral, 6 decimals
    uint256 size; // USDC notional, 6 decimals
    uint256 entryPrice; // 18 decimals
    bool isLong;
    bytes32 priceId; // market id
    address trader;
    uint64 openedAt;
    uint64 tpOrderId; // linked take-profit order, 0 if none
    uint64 slOrderId; // linked stop-loss order, 0 if none
    uint64 closeOrderId; // linked keeper-executed close order, 0 if none
    int256 entryFundingIndex;
}

/// @notice An instrument. Three independent switches define its structure:
///         - `quoteFeedId`: non-zero makes it a cross, priced as feed / quoteFeed (ETH/BTC, EUR/JPY, BTC in gold);
///         - `invert`: prices it as the reciprocal (JPY/USD from Pyth's USD/JPY);
///         - `expiry`: non-zero makes it a dated, cash-settled future that stops trading and settles at expiry.
struct Market {
    bool enabled; // false blocks new positions; closes and liquidations still work
    bool invert;
    uint16 maxLeverage; // whole multiples, 1..1000 (above 100x: keeper orders only)
    uint64 lastFundingTime;
    uint64 expiry; // 0 for perpetuals
    bytes32 feedId;
    bytes32 quoteFeedId; // 0 unless a cross
    uint256 maxOiPerSide; // USDC notional cap for each of long and short
    uint256 skewScale; // USDC notional floor for the skew-ratio denominator
    uint256 longOi;
    uint256 shortOi;
    uint256 longUnits; // sum of size * 1e36 / entryPrice over longs; used to mark the book to market
    uint256 shortUnits;
    int256 fundingIndex; // cumulative funding per unit of notional, 1e18; positive means longs have paid
    uint256 settlementPrice; // set once a dated market has settled
    string symbol;
}

struct MarketConfig {
    string symbol;
    bytes32 feedId;
    bytes32 quoteFeedId;
    bool invert;
    uint16 maxLeverage;
    uint64 expiry;
    uint256 maxOiPerSide;
    uint256 skewScale;
}

enum OrderType {
    LimitOpen, // open when price reaches the trigger; with a marketable trigger this is a keeper-executed market order
    TakeProfit,
    StopLoss,
    Close, // keeper-executed market close; `triggerPrice` is the worst acceptable price, 0 for none
    StopOpen // open once the market trades through the trigger in the breakout direction (stop-entry)
}

/// @dev LimitOpen and StopOpen are "open orders" (they escrow margin and open or add to a position); the other
///      three are "trigger orders" linked to a live position.
struct Order {
    address trader;
    bytes32 priceId; // market id
    OrderType orderType;
    bool isLong;
    uint64 createdAt;
    uint256 margin; // open orders only
    uint256 size; // open orders: notional to open; trigger orders: notional to close, 0 for the whole position
    uint256 triggerPrice; // 18 decimals
    uint256 takeProfit; // open orders only: bracket TP to attach on fill, 0 for none
    uint256 stopLoss; // open orders only: bracket SL to attach on fill, 0 for none
    uint256 feeBudget; // open orders only: escrowed maximum open fee
    uint256 executionFee; // keeper fee escrowed per execution (this order and each bracket)
}

struct OpenParams {
    bytes32 priceId;
    bool isLong;
    uint256 margin;
    uint256 size;
    uint256 acceptablePrice; // worst execution price accepted; 0 disables the check
    uint256 takeProfit; // optional bracket trigger, 0 for none
    uint256 stopLoss; // optional bracket trigger, 0 for none
}

struct LimitParams {
    bytes32 priceId;
    bool isLong;
    uint256 margin;
    uint256 size;
    // Limit: long fills at or below, short at or above. Stop-entry: long fills at or above, short at or below.
    uint256 triggerPrice;
    uint256 takeProfit;
    uint256 stopLoss;
    bool stopEntry; // true places a StopOpen (breakout) order instead of a LimitOpen
}

struct PositionView {
    bytes32 key;
    Position position;
    int256 fundingOwed; // positive: the position owes funding
    uint256 liquidationPrice; // long: liquidatable at or below (0 = never); short: at or above (0 = always)
}

struct OraclePrice {
    uint256 mid;
    uint256 bid;
    uint256 ask;
    uint256 publishTime;
}

enum PriceStatus {
    Ok,
    Unavailable,
    Stale,
    Invalid,
    ConfidenceTooWide
}
