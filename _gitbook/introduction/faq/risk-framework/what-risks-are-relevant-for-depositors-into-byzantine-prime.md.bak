# What risks are relevant for depositors into Byzantine Prime?

Risk in Byzantine Prime is not abstract. Every material risk is mapped to a measurable control. We cannot eliminate smart-contract or market risk entirely, but we can quantify, insure, and continuously monitor it. This philosophy mirrors institutional credit risk management, expressed through code.

<details>

<summary><strong>Smart contract risk</strong></summary>

#### Definition

A technical vulnerability in the smart contract code.

#### **Mitigation strategy**

The vault has undergone seven independent audits by industry-leading firms:

* [Zellic](https://github.com/Byzantine-Finance/debt-fund-vault-v2/blob/main/audits/2025-07-15-zellic.pdf)
* 2x Spearbit (reports to be released soon)
* [Blackthorn](https://github.com/Byzantine-Finance/debt-fund-vault-v2/blob/main/audits/2025-09-06-blackthorn.pdf)
* [Chainsecurity](https://github.com/Byzantine-Finance/debt-fund-vault-v2/blob/main/audits/2025-09-06-chainsecurity.pdf)
* Cantina competition (report to be released soon).

All custom adapters have been additionally audited by Spearbit. Find the full report [here](https://github.com/Byzantine-Finance/debt-fund-vault-v2/blob/main/audits/adapters/CompoundV3%20and%20ERC4626Merkl%20Adapters%20-%20Cantina%20-%20Sept%202025.pdf). Byzantine also integrates with [Hypernative](https://www.hypernative.io/), a real-time DeFi risk monitoring platform that continuously detects threats and anomalies, helping to prevent exploits before they impact client funds.

Additionally, two live bug bounty programs are in place. Bug bounty programs reward would-be hackers with large sums of money for finding and reporting a vulnerability, serving both as an incentive to prevent exploits as well as a statement of confidence about the correctness of a protocol’s code. For the Byzantine vault, two such programs are live:

* [Immunefi - $2,500,000](https://immunefi.com/bounty/morpho/)
* [Cantina - $2,500,000](https://cantina.xyz/bounties/35a5f0a1-2ffd-432c-8f3b-77d169add8c3)

Finally, clients can take out optional insurance to protect against any kind of smart contract failure. **This insurance policy is the ultimate recourse against any code-related loss.**

</details>

<details>

<summary><strong>Borrower counterparty risk</strong></summary>

#### Definition

Borrower fails to repay loan.

#### **Mitigation strategy**

All loans are over-collateralised with minimum collateral ratios of 120-150%. If that ratio is breached, collateral is automatically liquidated to make lenders whole.

To ensure the functioning of this liquidation mechanism, only battle-tested, heavily audited credit marketplaces with an excellent operating history are used - in this case Morpho, Aave, and Maker/Sky.

On Friday, Oct 10 2025, Morpho, Aave, and Maker saw liquidations of over $400m in a few hours - with no bad debt and no outages.

Details on the liquidation mechanism are found in the upcoming sections.

</details>

<details>

<summary><strong>Byzantine counterparty risk</strong></summary>

#### Definition

An insider at Byzantine corrupts the smart contract.

#### **Mitigation strategy**

Byzantine has no ability to upgrade the smart contract that administers user funds. Additionally, Byzantine never touches or routes user funds. In other words, there is no Byzantine insider risk.

Byzantine has the ability to change the asset manager (Keyrock), but this is subject to a lengthy timelock - a period during which Byzantine and third-party monitors can veto this change, or, in the worst case, during which clients have ample time to withdraw their assets.

</details>

<details>

<summary><strong>Marketplace counterparty risk (bankruptcy)</strong></summary>

#### Definition

Credit marketplace goes bankrupt.

#### **Mitigation strategy**

This risk is not relevant for the operation of the product. Smart contracts by design fulfil their intended function indefinitely. If the organisation around any of these credit marketplaces goes bankrupt, the smart contracts will continue to operate.

Once deployed, even these organisations themselves have no control over their smart contracts. This ensures bankruptcy-remoteness - not just financially, but also operationally.

</details>

<details>

<summary><strong>Marketplace counterparty risk (criminal)</strong></summary>

#### Definition

Insider at credit marketplace corrupts smart contracts to steal funds.

#### **Mitigation strategy**

None of the credit marketplaces that Byzantine uses have the unilateral right to alter any of the code in their deployed smart contracts.

They physically cannot edit deployed smart contracts even if they wanted to.

</details>

<details>

<summary><strong>Liquidity risk</strong></summary>

#### Definition

Sudden mass withdrawals or stress event delays redemptions.

#### **Mitigation strategy**

The credit marketplaces Byzantine works with are extensively battle-tested and have an excellent operating history. Loans are short-term and callable. Even in the rare case that an underlying market runs into liquidity constraints, the market’s automatic withdrawal queue executes withdrawals the second that liquidity is available again.

Additionally, Keyrock has the duty to monitor the portfolio for full liquidity, entering and exiting markets based on their ability to allow clients to redeem in full at any time.

</details>

<details>

<summary><strong>Custody risk</strong></summary>

#### Definition

Compromise of keys or unauthorised access to client wallets.

#### **Mitigation strategy**

This risk exists wholly outside of the purview of Byzantine.

Byzantine Prime allows clients to freely choose their way of holding the receipt tokens - the keys to withdrawing deposited assets.

Custody risk can be minimised by working with a qualified custodian. Such organisations are insured against breaches of their security.

</details>
