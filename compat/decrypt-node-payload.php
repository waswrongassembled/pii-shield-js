<?php

declare(strict_types=1);

/*
 * Proves that the PHP package reads vault payloads written by the Node port: decrypts every case from
 * compat/export-node-payloads.js with PHP's EncryptedVault and compares the mapping (values and order).
 * Exits non-zero on the first mismatch.
 *
 * Usage:
 *   npm run build && node compat/export-node-payloads.js <file>
 *   php compat/decrypt-node-payload.php <php-package-dir> <file>
 *
 * <php-package-dir> is packages/pii-shield of the Clarifile monorepo with `composer install` done.
 */

use Clarifile\PiiShield\Vault\EncryptedVault;
use Clarifile\PiiShield\Vault\Storage\VaultStorageInterface;

$packageDir = $argv[1] ?? null;
$file = $argv[2] ?? null;
if (null === $packageDir || null === $file || !is_file($packageDir.'/vendor/autoload.php') || !is_file($file)) {
    fwrite(\STDERR, "Usage: php compat/decrypt-node-payload.php <php-package-dir> <file>\n");
    fwrite(\STDERR, "The package dir must contain vendor/autoload.php (run composer install there).\n");
    exit(1);
}

require $packageDir.'/vendor/autoload.php';

$storage = new class implements VaultStorageInterface {
    /** @var array<string, string> */
    public array $items = [];

    public function put(string $id, string $payload, int $ttl): void
    {
        $this->items[$id] = $payload;
    }

    public function get(string $id): ?string
    {
        return $this->items[$id] ?? null;
    }

    public function remove(string $id): void
    {
        unset($this->items[$id]);
    }
};

$data = json_decode((string) file_get_contents($file), true, 512, \JSON_THROW_ON_ERROR);
$cases = $data['cases'] ?? [];
if ([] === $cases) {
    fwrite(\STDERR, "FAIL: {$file} contains no cases.\n");
    exit(1);
}

foreach ($cases as $case) {
    $payload = base64_decode($case['payload'], true);
    $key = base64_decode($case['key'], true);
    if (false === $payload || false === $key) {
        fwrite(\STDERR, "FAIL {$case['case']}: invalid base64.\n");
        exit(1);
    }
    $storage->items[$case['id']] = $payload;

    try {
        $mapping = (new EncryptedVault($storage, $key))->fetch($case['id']);
    } catch (Throwable $e) {
        fwrite(\STDERR, "FAIL {$case['case']}: ".$e::class.': '.$e->getMessage()."\n");
        exit(1);
    }

    // assertSame semantics: same keys, values and order.
    if ($mapping !== $case['mapping']) {
        fwrite(\STDERR, "FAIL {$case['case']}: the decrypted mapping differs.\n");
        exit(1);
    }

    // Byte parity: PHP re-encrypting with Node's nonce yields Node's payload.
    $nonce = substr($payload, 0, \SODIUM_CRYPTO_AEAD_XCHACHA20POLY1305_IETF_NPUBBYTES);
    $plaintext = json_encode($mapping, \JSON_THROW_ON_ERROR);
    if ($nonce.sodium_crypto_aead_xchacha20poly1305_ietf_encrypt($plaintext, $case['id'], $nonce, $key) !== $payload) {
        fwrite(\STDERR, "FAIL {$case['case']}: PHP encrypts the same mapping to different bytes.\n");
        exit(1);
    }

    fwrite(\STDOUT, "ok   {$case['case']}\n");
}

fwrite(\STDOUT, \sprintf("PHP decrypted all %d Node payloads.\n", \count($cases)));
