# Are there delays to convert stablecoins to fiat currency?

Stablecoins represent digital claims on fiat currency.

Redemption speed therefore depends on the stablecoin issuer and the investor’s conversion channel:

* **On-chain redemption:** Investors can withdraw stablecoins (e.g. USDC, EURC) instantly from the protocol.
* **Off-chain conversion:** Converting stablecoins into bank deposits generally takes a few hours to one business day, depending on the exchange, OTC desk, or custodian used.

Byzantine Prime itself does not handle fiat conversion; however, its design ensures stablecoin liquidity is always available, so investors can redeem their exposure immediately and then convert off-chain through their preferred counterparties.
