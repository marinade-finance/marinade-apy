import { web3 } from "@project-serum/anchor";
import { Marinade, MarinadeConfig, Provider } from '@marinade.finance/marinade-ts-sdk'
import { apy } from './apy.js';

//---------------------------------------------------
// compute avg APY for the last 5 epochs
//---------------------------------------------------
async function computeAPY() {

  // Connect to cluster - commitment=confirmed is required to get inflation rewards
  const connection = new web3.Connection(
    web3.clusterApiUrl("mainnet-beta"),
    "confirmed"
  );

  // get epoch info
  let epoch: web3.EpochInfo = await connection.getEpochInfo();

  // get marinade state
  const config = new MarinadeConfig({
    connection: connection,
    publicKey: undefined
  })
  const marinade = new Marinade(config)
  const state = await marinade.getMarinadeState()

  const managementFee =  state.rewardsCommissionPercent
  let avgApyData = await apy(connection, epoch.epoch - 5, epoch.epoch - 1, epoch.epoch, managementFee, {});
  console.log(avgApyData)
}

computeAPY();
