import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const deployScript = fileURLToPath(
  new URL("./deploy-dream-media-dev.ps1", import.meta.url),
);
const harness = String.raw`
param([string]$DeployScript,[string]$FixturePath)
$fixture = Get-Content -LiteralPath $FixturePath -Raw | ConvertFrom-Json
$global:awsCalls = @()
function global:aws {
  $operation = "$($args[0]):$($args[1])"
  $global:awsCalls += $operation
  $global:LASTEXITCODE = 0
  switch ($operation) {
    'sts:get-caller-identity' { @{Account='111111111111'} | ConvertTo-Json; break }
    'cloudformation:list-stacks' { @{StackSummaries=@($fixture.Stacks)} | ConvertTo-Json -Depth 10; break }
    's3api:head-bucket' { throw 'PREFLIGHT_PASSED' }
    default { throw "UNEXPECTED_AWS_OPERATION:$operation" }
  }
}
function global:npm { throw 'BUILD_RAN_EARLY' }
function global:docker { throw 'BUILD_RAN_EARLY' }
try {
  & $DeployScript -Deploy -EnableGateway -AwsProfile 'test-profile' -ExpectedAccount '111111111111' -MediaBucket 'test-bucket' -VpcId 'vpc-test' -Subnets @('subnet-test-a', 'subnet-test-b') -ApiUser 'test-user'
  throw 'UNEXPECTED_DEPLOYMENT_SUCCESS'
} catch {
  @{Error=$_.Exception.Message;Calls=$global:awsCalls} | ConvertTo-Json -Compress
}
`;

async function check(fixture) {
  const directory = await mkdtemp(join(tmpdir(), "dream-deploy-preflight-"));
  try {
    const runner = join(directory, "check.ps1"),
      data = join(directory, "fixture.json");
    await writeFile(runner, harness);
    await writeFile(data, JSON.stringify(fixture));
    const output = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-File",
        runner,
        "-DeployScript",
        deployScript,
        "-FixturePath",
        data,
      ],
      { encoding: "utf8", windowsHide: true, timeout: 15000 },
    );
    return JSON.parse(output.trim().split(/\r?\n/).at(-1));
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert(basename(directory).startsWith("dream-deploy-preflight-"));
    await rm(directory, { recursive: true, force: true });
  }
}
const rolledBack = {
  StackName: "ambatupost-media-budget-dev",
  StackId: "owned-stack",
  StackStatus: "ROLLBACK_COMPLETE",
  CreationTime: "2026-11-07T12:00:00Z",
};
test(
  "fresh deployment uses the existing shared pool without quota or reservation calls",
  { skip: process.platform !== "win32" },
  async () => {
    const result = await check({ Stacks: [] });
    assert.equal(result.Error, "PREFLIGHT_PASSED");
    assert.deepEqual(result.Calls, [
      "sts:get-caller-identity",
      "cloudformation:list-stacks",
      "s3api:head-bucket",
    ]);
  },
);
test(
  "failed stack is reported before builds and uploads, without asking for a quota increase",
  { skip: process.platform !== "win32" },
  async () => {
    const result = await check({ Stacks: [rolledBack] });
    assert.match(result.Error, /Delete only this failed stack/);
    assert(!/quota|106|BUILD_RAN_EARLY/.test(result.Error));
    assert(!result.Calls.includes("s3api:head-bucket"));
  },
);
test(
  "updates do not inspect or change other functions reservations",
  { skip: process.platform !== "win32" },
  async () => {
    const result = await check({
      Stacks: [{ ...rolledBack, StackStatus: "CREATE_COMPLETE" }],
    });
    assert.equal(result.Error, "PREFLIGHT_PASSED");
    assert(!result.Calls.some((call) => call.startsWith("lambda:")));
  },
);
test(
  "an in-progress stack is reported before any new build",
  { skip: process.platform !== "win32" },
  async () => {
    const result = await check({
      Stacks: [{ ...rolledBack, StackStatus: "CREATE_IN_PROGRESS" }],
    });
    assert.match(result.Error, /Finish or repair/);
    assert(!result.Calls.includes("s3api:head-bucket"));
    assert(!result.Error.includes("BUILD_RAN_EARLY"));
  },
);
