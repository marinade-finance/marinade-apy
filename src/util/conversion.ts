import { web3 } from "@project-serum/anchor";

export function lamportsToSol(lamports: number): number {
    return lamports / web3.LAMPORTS_PER_SOL;
}
