import {
  Connection,
  Keypair,
  TransactionMessage,
  VersionedTransaction,
  AddressLookupTableAccount,
  TransactionInstruction,
  PublicKey,
} from "@solana/web3.js";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import BN from "bn.js";

dotenv.config();

export function loadKeypair(envVar: string): Keypair {
  const filePath = process.env[envVar];
  if (!filePath) {
    throw new Error(`Environment variable ${envVar} not set`);
  }
  const resolved = path.resolve(filePath);
  const secretKey = JSON.parse(fs.readFileSync(resolved, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(secretKey));
}

export function getConnection(): Connection {
  const rpcUrl = process.env.RPC_URL;
  if (!rpcUrl) {
    throw new Error("RPC_URL not set");
  }
  return new Connection(rpcUrl, "confirmed");
}

export async function sendAndConfirmTx(
  connection: Connection,
  instructions: TransactionInstruction[],
  payer: Keypair,
  signers: Keypair[] = [],
  lookupTables: AddressLookupTableAccount[] = []
): Promise<string> {
  const latestBlockhash = await connection.getLatestBlockhash("confirmed");

  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: latestBlockhash.blockhash,
    instructions,
  }).compileToV0Message(lookupTables);

  const tx = new VersionedTransaction(message);
  tx.sign([payer, ...signers]);

  const simulation = await connection.simulateTransaction(tx);
  if (simulation.value.err) {
    console.error("Simulation failed:", simulation.value.err);
    console.error("Logs:", simulation.value.logs);
    throw new Error(`Transaction simulation failed: ${JSON.stringify(simulation.value.err)}`);
  }

  const signature = await connection.sendTransaction(tx, {
    skipPreflight: false,
    maxRetries: 3,
  });

  await connection.confirmTransaction(
    {
      signature,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    },
    "confirmed"
  );

  return signature;
}

export async function loadLookupTable(
  connection: Connection,
  address: PublicKey
): Promise<AddressLookupTableAccount> {
  const result = await connection.getAddressLookupTable(address);
  if (!result.value) {
    throw new Error(`Lookup table not found: ${address.toBase58()}`);
  }
  return result.value;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function formatUSDC(amount: BN | number): string {
  const val = typeof amount === "number" ? amount : amount.toNumber();
  return `$${(val / 1e6).toFixed(2)}`;
}
