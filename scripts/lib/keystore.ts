import { Wallet } from 'ethers';

export function walletFromPrivateKey(input: string): Wallet {
  const trimmed = input.trim();
  const privateKey = trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;

  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error('The private key must contain exactly 32 bytes of hexadecimal data.');
  }

  try {
    return new Wallet(privateKey);
  } catch {
    throw new Error('The private key is not a valid secp256k1 private key.');
  }
}

export function validateNewKeystorePassword(password: string): void {
  if (password.length < 12) throw new Error('The keystore password must contain at least 12 characters.');
}
