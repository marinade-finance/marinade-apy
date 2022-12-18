//
// compute Marinade staking apy
//
import { web3 } from "@project-serum/anchor";
import { writeFileSync } from "fs";
import { lamportsToSol } from "./util/conversion.js";
import fetch from 'node-fetch'

export class ApyDataResult {
  avgApy: number = 0;
  fromEpoch: number = 0;
  toEpoch: number = 0;
  validators: number = 0; // validator count
};

type Delegation = {
    activationEpoch: string,
    deactivationEpoch: string,
    stake: string, // lamports
    voter: string,
    warmupCooldownRate: number,
}

type InflationRewardAddingCommission = web3.InflationReward & {commission:number};

type StakeViewInfo = {
  beginTimestamp: number;
  endTimestamp: number;
}

// we assume 136.576 epochs per year
// according to stakeview.app 30-last-epochs Avg Epoch Duration: 2 days 16 hours 8 minutes 25 seconds
// so 365*24/(2*24+16+8/60+25/3600) = 136.576
// and 100*(1.00055 ^ 136.576) = 107.8, (7.8% APY) so we can say that 0.055% is a good approx for each epoch rewards %
// 2022-1102 3 epoch - Avg Epoch Duration: 2 days 6 hours 44 minutes 7 seconds (54.73hs) 
/*
last epochs duration from LJ 2022-11-02
54.916666666666664
54.264722222222225
54.750277777777775
52.91638888888889
53.75944444444445
57.583333333333336
56.583333333333336
60.91694444444445
*/
let epochDurationHs = 54.73527 // fallback value if we can not get data from stakeview.app

/// compute apy by reading accounts & rewards from the chain
export async function apy(connection: web3.Connection, 
  fromEpoch: number, toEpoch: number, currentEpoch: number, managementFee:number, options: any): Promise<ApyDataResult> {

  // get avg epoch duration from stakeview.app
  const url = "https://stakeview.app/apy/prev3.json"
  try {
    const response = await fetch(url)
    const sv3epochData: StakeViewInfo = await response.json()
    if (sv3epochData && sv3epochData.beginTimestamp && sv3epochData.endTimestamp) {
      const avgDurationSeconds = (sv3epochData.endTimestamp - sv3epochData.beginTimestamp)/3
      epochDurationHs = avgDurationSeconds/60/60
      console.log("avg last 3 epoch duration hs",epochDurationHs)
    }
  }
  catch(ex){
    console.error("ERR:computing epoch duration from "+url)
    console.error(ex)
  }

  const MARINADE_BASE_EPOCH = 207;
  try {

    if (fromEpoch < MARINADE_BASE_EPOCH + 1) fromEpoch = MARINADE_BASE_EPOCH + 1;

    console.log(fromEpoch, toEpoch);

    let totalOneRewards: number = 0;
    let sumAPY = 0;
    let sumRawAPY = 0;
    let sumAPYPreMF = 0;
    let sumEpochCount = 0;
    let validatorsInfo:Record<string,number>={};
    for (let epoch = fromEpoch; epoch <= toEpoch; epoch++) {

      let accounts = [];
      if (options.a) {
        accounts.push(new web3.PublicKey(options.a))
      }
      else {
        // get all accounts managed by marinade
        let stakeAccounts = await connection.getParsedProgramAccounts(new web3.PublicKey("Stake11111111111111111111111111111111111111"),
          {
            "filters": [
              {
                "dataSize": 200
              },
              {
                "memcmp": {
                  "offset": 44,
                  "bytes": "9eG63CdHjsfhHmobHgLtESGC8GabbmRcaSpHAZrtmhco"
                }
              }
            ]
          });
        for (let row of stakeAccounts) {
          const parsedAccountData = row.account.data as web3.ParsedAccountData;
          if (parsedAccountData.parsed.info.stake) {
            let delegation: Delegation = parsedAccountData.parsed.info.stake.delegation;
            if (delegation && +delegation.activationEpoch >= MARINADE_BASE_EPOCH && +delegation.activationEpoch <= epoch - 1) {
              accounts.push(row.pubkey)
              // count stake accounts per validator
              validatorsInfo[delegation.voter] = (validatorsInfo[delegation.voter]||0)+1
            }
          }
        }
      }

      let result = await connection.getInflationReward(accounts, epoch);
      //console.log(result);
      let inx = 0;
      let epochPreBal: number = 0;
      let epochRewards: number = 0;
      let epochRawRewards: number = 0;
      let epochEffectiveRewardsPre: number = 0;
      let computedList = [];
      for (let infoItem of result) {
        let acc = accounts[inx++];
        if (infoItem) {
          const info = infoItem as InflationRewardAddingCommission;
          const preBalance = info.postBalance - info.amount;
          computedList.push({
            pubkey: acc.toBase58(), pre: lamportsToSol(preBalance), rewards: lamportsToSol(info.amount), post: lamportsToSol(info.postBalance), 
            commission: info.commission, apy: apyOf(preBalance, info.amount, info.commission)
          })
          //console.log(acc.toBase58(), lamportsToSol(preBalance), lamportsToSol(info.amount), lamportsToSol(info.postBalance), apyOf(info))
          epochPreBal += preBalance;
          epochRawRewards += info.amount;
          const effectiveRewardsPre = info.amount *((100-info.commission)/100);
          epochEffectiveRewardsPre += effectiveRewardsPre;
          const effectiveRewards = effectiveRewardsPre * ((100-managementFee)/100);
          epochRewards += effectiveRewards;
          
        }
      }

      computedList.sort((a, b) => b.apy - a.apy)
      for (let item of computedList) {
        console.log(item.pubkey, item.pre, item.rewards, item.post, item.commission + "%", item.apy)
      }
      // save for comparison/stats
      writeFileSync(`on-epoch-${currentEpoch}-accounts-epoch-${epoch}.json`, JSON.stringify(computedList));

      console.log("---------------------")
      console.log(`total epoch ${epoch} pre:${lamportsToSol(epochPreBal)}, rew:${lamportsToSol(epochRewards)}, after:${lamportsToSol(epochPreBal + epochRewards)},`+
                  ` raw-apy:${apyForOne(epochRawRewards / epochPreBal)}, pre-mf-apy:${apyForOne(epochEffectiveRewardsPre / epochPreBal)}, apy:${apyForOne(epochRewards / epochPreBal)},`+
                  ` management-fee:${managementFee}, validators: ${Object.keys(validatorsInfo).length}`)
      console.log("---------------------")
      console.log("---------------------")
      totalOneRewards += epochRewards / epochPreBal;
      sumRawAPY += apyForOne(epochRawRewards / epochPreBal);
      sumAPYPreMF += apyForOne(epochEffectiveRewardsPre / epochPreBal);
      sumAPY += apyForOne(epochRewards / epochPreBal);
      sumEpochCount += 1;

    }
    console.log("---------------------")
    console.log("---------------------")
    console.log("---------------------")
    console.log(`${fromEpoch}-${toEpoch}`, totalOneRewards, apyFor(toEpoch - fromEpoch + 1, totalOneRewards))

    const avgRawApy = Math.round(sumRawAPY / sumEpochCount * 100) / 100;
    console.log(`${fromEpoch}-${toEpoch}`, `avg raw APY ${sumEpochCount} epochs: ${avgRawApy}`)

    const avgPreMFApy = Math.round(sumAPYPreMF / sumEpochCount * 100) / 100;
    console.log(`${fromEpoch}-${toEpoch}`, `avg pre-management fee APY ${sumEpochCount} epochs: ${avgPreMFApy}`)

    const avgApy = Math.round(sumAPY / sumEpochCount * 100) / 100;
    console.log(`${fromEpoch}-${toEpoch}`, `avg marinade effective APY ${sumEpochCount} epochs: ${avgApy}`)

    console.log("---------------------")

    return { avgApy: avgApy, fromEpoch: fromEpoch, toEpoch: toEpoch, validators: Object.keys(validatorsInfo).length };
  }
  catch (ex) {
    console.error(ex);
    throw ex;
  }
}

export function apyFor(numEpochs: number, interestPerPeriod: number): number {
  const apy = ((1 + interestPerPeriod) ** ( (365*24/epochDurationHs) / numEpochs)) - 1
  return Math.round(apy * 1000000) / 10000;
}
export function apyForOne(interestPerPeriod: number): number {
  return apyFor(1, interestPerPeriod);
}
function apyOf(principal:number, rawGeneratedAmount:number, commission:number ): number {
  const userRewards = rawGeneratedAmount * ((100-commission)/100)
  const effectiveInterestRate = userRewards / principal
  return apyForOne(effectiveInterestRate)
}

