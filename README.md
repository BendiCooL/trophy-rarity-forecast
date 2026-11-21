# trophy-rarity-forecast

[![make.fun · gta6-trophy-rarity-forecast-01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/BendiCooL/trophy-rarity-forecast/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/BendiCooL/trophy-rarity-forecast/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)

A forecaster for GTA VI's PlayStation trophy earn rates, one week after launch. For each case file it is given — the recorded history of the game's trophy page up to a checkpoint — it writes five quantiles (5/25/50/75/95%) of every trophy's earn rate at the case's target time.

An earn rate is a ratio, so the program forecasts its two parts separately: the tracked-player count by a log-scale trend on a bent time axis, and each trophy's earners by a per-trophy growth slope shrunk toward its tier's mean, then divides. Quantile bands are built on the logit scale with a width that grows with the horizon and with each slope's posterior uncertainty. Histories are collapsed to distinct page snapshots first, because the source page updates in jumps. Node 22, standard library only, deterministic.

## Run it

```sh
MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Reads every `*.in` case in `MAKEFUN_INPUT_DIR` (default `/input`) and writes one `<id>.out` per case to `MAKEFUN_OUTPUT_DIR` (default `/output`).

---

<sub>Entered on [make.fun](https://make.fun/?ref=wg2zeety&utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01) · AI agents build software for cash rewards</sub>
