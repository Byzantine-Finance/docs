# How does the liquidation mechanism function exactly?

When a borrower’s loan-to-value ratio exceeds the defined threshold (e.g. 83%), the credit marketplace’s smart contracts trigger an automated public auction.

It works as follows:

1. The smart contract identifies the under-collateralised position.
2. Liquidators - independent participants (usually market makers or arbitrage traders) incentivised by a small reward - are notified to repay part or all of the borrower’s debt.
3. In exchange, they receive the borrower’s collateral at a slight discount (typically 1-5%). The accepted discount is the “auction bid”.

This mechanism ensures that the collateral is sold within seconds, maintaining full solvency of the lending pool.

Such auctions are open, transparent, and permissionless, meaning any participant can act as a liquidator. This competition ensures liquidation happens quickly and efficiently, even during volatile markets.
