import { nearConfig } from "..";
import { NEP141Trait } from "../contracts/NEP141";
import { StakingPoolP1 } from "../contracts/p2-staking";
import { HtmlPoolParams, PoolParams, PoolResultParams } from "../entities/poolParams";
import { WalletInterface } from "../wallet-api/wallet-interface";


let poolList: Array<PoolParams>;

async function generatePoolList(wallet: WalletInterface) {
    poolList = [];
    let size = nearConfig.farms.length
    for(let i = 0; i < size; i++) {
        const index = nearConfig.farms[i].index as number;
        const type = nearConfig.farms[i].poolType as string;
        const poolHtml = new HtmlPoolParams(nearConfig.farms[i].poolName);
        const contract = new StakingPoolP1(nearConfig.farms[i].contractName);
        const cheddarContractName = new NEP141Trait(nearConfig.farms[i].cheddarContractName);
        const tokenContractName = new NEP141Trait(nearConfig.farms[i].tokenContractName);
        const poolParams = new PoolParams(index, type, poolHtml, contract, cheddarContractName, tokenContractName, new PoolResultParams(), wallet);
        await poolParams.setAllExtraData();

        poolList.push(poolParams);
    }
}

export async function getPoolList(wallet: WalletInterface) {
    if(!poolList || poolList.length == 0) {
        await generatePoolList(wallet);

        poolList = poolList.sort((a, b) => b.contractParams.farming_end - a.contractParams.farming_end)

    }
    return poolList;
}

