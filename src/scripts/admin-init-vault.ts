import {
  Keypair,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { VoltrClient } from "@voltr/vault-sdk";
import BN from "bn.js";
import { VAULT_CONFIG } from "../config/vault";
import { USDC_MINT } from "../config/constants";
import { getConnection, loadKeypair } from "../utils/helpers";

async function main() {
  console.log("Initializing Arashi Vault...\n");

  const connection = getConnection();
  const admin = loadKeypair("ADMIN_KEYPAIR_PATH");
  const manager = loadKeypair("MANAGER_KEYPAIR_PATH");

  const vc = new VoltrClient(connection, admin);

  const vaultKeypair = Keypair.generate();
  console.log(`Vault address: ${vaultKeypair.publicKey.toBase58()}`);
  console.log(`Admin: ${admin.publicKey.toBase58()}`);
  console.log(`Manager: ${manager.publicKey.toBase58()}`);

  const initIx = await vc.createInitializeVaultIx(
    {
      config: {
        maxCap: VAULT_CONFIG.maxCap,
        startAtTs: new BN(0),
        lockedProfitDegradationDuration:
          VAULT_CONFIG.lockedProfitDegradationDuration,
        managerManagementFee: VAULT_CONFIG.managementFee.toNumber(),
        managerPerformanceFee: VAULT_CONFIG.performanceFee.toNumber(),
        adminManagementFee: 0,
        adminPerformanceFee: 0,
        redemptionFee: VAULT_CONFIG.redemptionFee.toNumber(),
        issuanceFee: VAULT_CONFIG.issuanceFee.toNumber(),
        withdrawalWaitingPeriod: VAULT_CONFIG.withdrawalWaitingPeriod,
      },
      name: VAULT_CONFIG.name,
      description: VAULT_CONFIG.description,
    },
    {
      vault: vaultKeypair.publicKey,
      vaultAssetMint: USDC_MINT,
      admin: admin.publicKey,
      manager: manager.publicKey,
      payer: admin.publicKey,
    }
  );

  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: admin.publicKey,
    recentBlockhash: blockhash,
    instructions: [initIx],
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);
  tx.sign([admin, vaultKeypair]);

  const sig = await connection.sendTransaction(tx, { skipPreflight: false });
  await connection.confirmTransaction(sig, "confirmed");

  console.log(`\nVault initialized! Signature: ${sig}`);
  console.log(`\nUpdate your .env file:`);
  console.log(`VAULT_ADDRESS="${vaultKeypair.publicKey.toBase58()}"`);
}

main().catch(console.error);
