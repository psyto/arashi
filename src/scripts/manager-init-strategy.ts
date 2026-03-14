import { PublicKey } from "@solana/web3.js";
import { VoltrClient } from "@voltr/vault-sdk";
import BN from "bn.js";
import {
  DRIFT_ADAPTOR_PROGRAM_ID,
  DRIFT_PROGRAM_ID,
  DISCRIMINATORS,
} from "../config/constants";
import { vaultAddress } from "../config/vault";
import {
  getConnection,
  loadKeypair,
  sendAndConfirmTx,
} from "../utils/helpers";

async function main() {
  console.log("Initializing Drift User strategy for Arashi Vault...\n");

  const connection = getConnection();
  const manager = loadKeypair("MANAGER_KEYPAIR_PATH");

  const vc = new VoltrClient(connection, manager);

  const [strategy] = PublicKey.findProgramAddressSync(
    [Buffer.from("drift_user")],
    DRIFT_ADAPTOR_PROGRAM_ID
  );

  console.log(`Vault: ${vaultAddress.toBase58()}`);
  console.log(`Strategy: ${strategy.toBase58()}`);

  const { vaultStrategyAuth } = vc.findVaultStrategyAddresses(
    vaultAddress,
    strategy
  );

  const [driftUserStats] = PublicKey.findProgramAddressSync(
    [Buffer.from("user_stats"), vaultStrategyAuth.toBuffer()],
    DRIFT_PROGRAM_ID
  );
  const [driftUser] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("user"),
      vaultStrategyAuth.toBuffer(),
      new BN(0).toArrayLike(Buffer, "le", 2),
    ],
    DRIFT_PROGRAM_ID
  );
  const [driftState] = PublicKey.findProgramAddressSync(
    [Buffer.from("drift_state")],
    DRIFT_PROGRAM_ID
  );

  const nameBytes = Buffer.from("Arashi");
  const nameLenBuf = Buffer.alloc(4);
  nameLenBuf.writeUInt32LE(nameBytes.length);
  const marginBuf = Buffer.from([1]);
  const additionalArgs = Buffer.concat([nameLenBuf, nameBytes, marginBuf]);

  const initStrategyIx = await vc.createInitializeStrategyIx(
    {
      instructionDiscriminator: DISCRIMINATORS.INITIALIZE_USER,
      additionalArgs,
    },
    {
      payer: manager.publicKey,
      vault: vaultAddress,
      manager: manager.publicKey,
      strategy,
      adaptorProgram: DRIFT_ADAPTOR_PROGRAM_ID,
      remainingAccounts: [
        { pubkey: driftUserStats, isSigner: false, isWritable: true },
        { pubkey: driftUser, isSigner: false, isWritable: true },
        { pubkey: driftState, isSigner: false, isWritable: false },
        { pubkey: DRIFT_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
    }
  );

  const sig = await sendAndConfirmTx(connection, [initStrategyIx], manager);
  console.log(`\nDrift User strategy initialized! Signature: ${sig}`);
}

main().catch(console.error);
