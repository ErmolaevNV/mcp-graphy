import { test } from 'node:test';
import assert from 'node:assert';
import { analyzeFile } from '../analyzer.js';
import path from 'node:path';
import fs from 'node:fs/promises';

const TEST_FILE = path.resolve('test_class.php');

test('Analyzer should parse class structure correctly', async (t) => {
    const phpCode = `<?php
namespace App\\Tests;

use App\\Models\\User;
use App\\Interfaces\\AuthInterface;
use App\\Traits\\Loggable;

class AuthController extends BaseController implements AuthInterface {
    use Loggable;

    private $service;

    public function login(User $user): void {
        $this->service->auth($user);
    }
}
`;

    await fs.writeFile(TEST_FILE, phpCode);

    try {
        const results = await analyzeFile(TEST_FILE);
        
        assert.strictEqual(results.length, 1);
        const cls = results[0];

        assert.strictEqual(cls.fqn, 'App\\Tests\\AuthController');
        assert.strictEqual(cls.type, 'class');
        assert.strictEqual(cls.extends, 'App\\Tests\\BaseController'); // BaseController is in same namespace
        
        // Check implements
        assert.ok(cls.implements.includes('App\\Interfaces\\AuthInterface'));

        // Check traits
        assert.ok(cls.traits.includes('App\\Traits\\Loggable'));

        // Check methods
        const loginMethod = cls.members.find(m => m.name === 'login');
        assert.ok(loginMethod);
        assert.strictEqual(loginMethod?.visibility, 'public');

        // Check dependencies
        assert.ok(cls.dependencies.has('App\\Models\\User'));
        assert.ok(cls.dependencies.has('App\\Interfaces\\AuthInterface'));
        assert.ok(cls.dependencies.has('App\\Traits\\Loggable'));

    } finally {
        await fs.unlink(TEST_FILE);
    }
});

