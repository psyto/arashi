import { VoltrClient } from "@voltr/vault-sdk";
import { DRIFT_ADAPTOR_PROGRAM_ID } from "../config/constants";
import { vaultAddress } from "../config/vault";
import { getConnection, loadKeypair, sendAndConfirmTx } from "../utils/helpers";

async function main() {
  console.log("Adding Drift adaptor to Arashi Vault...\n");

  const connection = getConnection();
  const admin = loadKeypair("ADMIN_KEYPAIR_PATH");

  const vc = new VoltrClient(connection, admin);

  console.log(`Vault: ${vaultAddress.toBase58()}`);
  console.log(`Drift Adaptor: ${DRIFT_ADAPTOR_PROGRAM_ID.toBase58()}`);

  const addAdaptorIx = await vc.createAddAdaptorIx({
    vault: vaultAddress,
    payer: admin.publicKey,
    admin: admin.publicKey,
    adaptorProgram: DRIFT_ADAPTOR_PROGRAM_ID,
  });

  const sig = await sendAndConfirmTx(connection, [addAdaptorIx], admin);
  console.log(`\nDrift adaptor added! Signature: ${sig}`);
}

main().catch(console.error);
