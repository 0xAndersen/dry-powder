# Arc notes carried over from Project Nexus

Addresses and facts Nexus verified on Arc (October 2026). Re-check before relying on them for mainnet.

## Chain

| | Testnet | Mainnet |
| --- | --- | --- |
| Chain id | 5042002 | 5042 |
| Gas | native USDC, 18 decimals; base fee floor 20 gwei (lower bids are dropped) | same |
| USDC ERC-20 interface | `0x3600000000000000000000000000000000000000` (6 decimals; contracts use only this) | same |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` | same |
| `eth_getLogs` | at most 10,000 blocks per call (the app reads 2,000 at a time) | same |

## Circle assets and infrastructure

| | Testnet | Mainnet |
| --- | --- | --- |
| EURC | `0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a` | `0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1` |
| USYC | `0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C` | `0x8a5D989Bbb96929F689B0200f435f53dA42bF490` |
| cirBTC | `0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF` | `0x171A4217b86A807A64eB94757Db6849fb4bDbAA0` |
| CCTP V2 TokenMessenger (Arc domain 26) | `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA` | `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d` |
| CCTP V2 MessageTransmitter | `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275` | `0x81D40F21F12A8F0E3252Bccb954D722d4c464B64` |
| Gateway wallet | `0x0077777d7EBA4688BDeF3E311b846F25870A19B9` | `0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE` |
| Gateway minter | `0x0022222ABE238Cc2C7Bb1f21003F0a260052475B` | `0x2222222d7164433c4C09B0b0D809a9b52C04C205` |
| ERC-8004 identity registry | `0x8004A818BFB912233c491871b3d84c89A494BD9e` | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |

Safe v1.4.1 is canonical on Arc testnet: factory `0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67`, SafeL2 singleton
`0x29fcB43b46531BcA003ddC8FCB67FFE91900C762`, fallback handler `0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99`.

## Oracles

- **Chainlink Data Feeds** exist on Arc **mainnet** only, updating every few minutes to hours (too slow on their
  own for leveraged perps; usable as a sanity band or for slow FX/RWA markets). Proxies: BTC/USD
  `0x4c39AFed709fA19eA912552cFaF8aD89d12a88c6`, EURC/USD `0x71B0305ACA6A29d6485f9e4ac5a333af5Df2b62c`,
  SOL/USD `0x2d04D354f5fDaE3De723df475745B0a9B4edf90C`, JPY/USD `0xbD6c2a896745c7e13a2ccC2F6163c6801be0b3aD`,
  USDC/USD `0x0C92645D7B1886458f819404c7FeEDDFE12d0C19`, XAUM reference rate (18 dec)
  `0xB27522566BE765c94D21BFA0A9a1e19934999AB2`; also LINK, XRP, UNI, AAVE, BCH, cbBTC, AUD, CAD, MXN, KRW, USDT.
  No ETH/USD or EUR/USD feed found.
- **Stork**: contract `0xacC0a0cF13571d30B4b8637996F5D6D774d4fd62`; testnet feed silent since June 2026; REST
  needs an API key.
- **Pyth**: Hermes needs a paid API key (since 2026-08-26); the Pyth contract on Arc testnet holds stale prices.
- What runs on testnet today: `PublisherOracle` fed from Kraken by the keeper (see `V2_SPEC.md`).
