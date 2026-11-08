param(
  [switch]$Deploy,
  [switch]$Check,
  [switch]$EnableGateway,
  [string]$AwsProfile = '',
  [string]$Region = 'ap-southeast-1',
  [string]$ExpectedAccount = '',
  [string]$MediaBucket = '',
  [string]$VpcId = '',
  [string[]]$Subnets = @(),
  [string]$Repository = 'ambatupost-media-dev',
  [string]$ApiUser = '',
  [string]$DatabaseKmsKeyArn = '',
  [string[]]$Origins = @('http://localhost:3001','capacitor://localhost')
)
$ErrorActionPreference = 'Stop'
$adminRoot = Split-Path $PSScriptRoot -Parent
$workspace = Split-Path $adminRoot -Parent
$stackName = 'ambatupost-media-budget-dev'
$workerParameter = "arn:aws:ssm:${Region}:${ExpectedAccount}:parameter/ambatupost/dev/worker-db"
$gatewayParameter = "arn:aws:ssm:${Region}:${ExpectedAccount}:parameter/ambatupost/dev/gateway-db"
Write-Host "Target: $stackName / $ExpectedAccount / $Region / bucket $MediaBucket"
Write-Host 'Model: about US$3.50/month for the documented light workload, before credits; target <=US$5, not a billing cap.'
Write-Host 'Read docs/ambatupost-phase-4.md and apply migration 019 first. Existing SSM credentials are reused.'
if (!$Deploy -and !$Check) {
  Write-Host 'Preview only. Add -Deploy to build/push the worker, upload Lambda code, create the disabled stack and merge bucket settings.'
  Write-Host 'Use -Check -EnableGateway to check the account identity and stack state without building or changing resources.'
  Write-Host 'Add -EnableGateway only after checking the schema, API configuration and cost limits.'
  Write-Host 'Supply deployment-specific values as parameters; see docs/ambatupost-phase-4.md.'
  exit 0
}
if ([string]::IsNullOrWhiteSpace($AwsProfile) -or $ExpectedAccount -notmatch '^\d{12}$') {
  throw 'Supply -AwsProfile and the 12-digit -ExpectedAccount before checking or deploying.'
}
if ($Deploy -and ([string]::IsNullOrWhiteSpace($MediaBucket) -or [string]::IsNullOrWhiteSpace($VpcId) -or $Subnets.Count -lt 2 -or @($Subnets | Where-Object { [string]::IsNullOrWhiteSpace($_) }).Count -gt 0 -or [string]::IsNullOrWhiteSpace($ApiUser))) {
  throw 'Supply -MediaBucket, -VpcId, at least two -Subnets, and -ApiUser before deploying.'
}
function Invoke-Aws {
  param([string[]]$Arguments)
  $result = & aws @Arguments --profile $AwsProfile --region $Region --no-cli-pager
  if ($LASTEXITCODE -ne 0) { throw "AWS command failed: $($Arguments[0]) $($Arguments[1])" }
  return $result
}
$identity = Invoke-Aws -Arguments @('sts','get-caller-identity','--output','json') | ConvertFrom-Json
if ($identity.Account -ne $ExpectedAccount) { throw 'AWS account mismatch; no changes made.' }
$summaries = Invoke-Aws -Arguments @('cloudformation','list-stacks','--output','json') | ConvertFrom-Json
$existingStack = $summaries.StackSummaries | Where-Object { $_.StackName -eq $stackName -and $_.StackStatus -ne 'DELETE_COMPLETE' } | Sort-Object CreationTime -Descending | Select-Object -First 1
$preflightErrors = [System.Collections.Generic.List[string]]::new()
if ($existingStack -and $existingStack.StackStatus -eq 'ROLLBACK_COMPLETE') {
  $preflightErrors.Add("Stack $stackName is ROLLBACK_COMPLETE. Delete only this failed stack in CloudFormation, wait for deletion, then rerun. Migration 019, the existing bucket, ECR and SSM parameters are reused.")
} elseif ($existingStack -and $existingStack.StackStatus -notin @('CREATE_COMPLETE','UPDATE_COMPLETE','UPDATE_ROLLBACK_COMPLETE','IMPORT_COMPLETE','IMPORT_ROLLBACK_COMPLETE')) {
  $preflightErrors.Add("Stack $stackName is $($existingStack.StackStatus). Finish or repair that operation before deployment.")
}
if ($preflightErrors.Count) { throw ($preflightErrors -join [Environment]::NewLine) }
Write-Host 'Preflight passed. Lambda uses the existing shared account capacity; no positive reservations are configured.'
if (!$Deploy) { exit 0 }
Invoke-Aws -Arguments @('s3api','head-bucket','--bucket',$MediaBucket) | Out-Null
$version = 'budget-' + [DateTime]::UtcNow.ToString('yyyyMMddHHmmss')
$registry = "$ExpectedAccount.dkr.ecr.$Region.amazonaws.com"
$image = "${registry}/${Repository}:${version}"
Push-Location (Join-Path $adminRoot 'dream-media')
$previousProfile = $env:AWS_PROFILE
$previousRegion = $env:AWS_REGION
try {
  $env:AWS_PROFILE = $AwsProfile
  $env:AWS_REGION = $Region
  & npm ci --omit=dev
  if ($LASTEXITCODE -ne 0) { throw 'Media dependency installation failed.' }
  & docker build --platform linux/amd64 -t $image .
  if ($LASTEXITCODE -ne 0) { throw 'Worker image build failed.' }
  # Repository was created for the previous dev deployment and is intentionally reused.
  Invoke-Aws -Arguments @('ecr','describe-repositories','--repository-names',$Repository) | Out-Null
  Invoke-Aws -Arguments @('ecr','get-login-password') | & docker login --username AWS --password-stdin $registry
  if ($LASTEXITCODE -ne 0) { throw 'ECR login failed.' }
  & docker push $image
  if ($LASTEXITCODE -ne 0) { throw 'Worker image push failed.' }
  $imageDetail = Invoke-Aws -Arguments @('ecr','describe-images','--repository-name',$Repository,'--image-ids',"imageTag=$version",'--output','json') | ConvertFrom-Json
  $immutableImage = "${registry}/${Repository}@$($imageDetail.imageDetails[0].imageDigest)"
  $temporary = Join-Path $workspace ".tmp/dream-media-$version"
  & node package-lambda.mjs $temporary
  if ($LASTEXITCODE -ne 0) { throw 'Lambda packaging failed.' }
  $zip = "$temporary.zip"
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::CreateFromDirectory($temporary, $zip, [System.IO.Compression.CompressionLevel]::Optimal, $false)
  $hash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
  $artifactKey = "ambatupost/dev/deployment/$hash.zip"
  Invoke-Aws -Arguments @('s3','cp',$zip,"s3://$MediaBucket/$artifactKey",'--only-show-errors') | Out-Null
  $enabled = if ($EnableGateway) { 'true' } else { 'false' }
  $parameters = @("Stage=dev","MediaBucket=$MediaBucket","ImageUri=$immutableImage","CodeArtifactKey=$artifactKey","VpcId=$VpcId","Subnets=$($Subnets -join ',')","WorkerDatabaseParameterArn=$workerParameter","GatewayDatabaseParameterArn=$gatewayParameter","GatewayEnabled=$enabled")
  if ($DatabaseKmsKeyArn) { $parameters += "DatabaseKmsKeyArn=$DatabaseKmsKeyArn" }
  Invoke-Aws -Arguments (@('cloudformation','deploy','--stack-name',$stackName,'--template-file',(Join-Path $adminRoot 'infra/ambatupost-media.yaml'),'--capabilities','CAPABILITY_IAM','--no-fail-on-empty-changeset','--parameter-overrides') + $parameters) | Out-Null
  $deployed = Invoke-Aws -Arguments @('cloudformation','describe-stacks','--stack-name',$stackName,'--output','json') | ConvertFrom-Json
  $outputs = @{}
  foreach ($row in $deployed.Stacks[0].Outputs) { $outputs[$row.OutputKey] = $row.OutputValue }
  Invoke-Aws -Arguments @('iam','attach-user-policy','--user-name',$ApiUser,'--policy-arn',$outputs.AppMediaPolicyArn) | Out-Null
  & node configure-bucket.mjs $MediaBucket dev $outputs.InputQueueArn @Origins --apply
  if ($LASTEXITCODE -ne 0) { throw 'Bucket merge failed; keep AMBATUPOST_MEDIA_ENABLED=false until repaired.' }
  Write-Host "Gateway base (remove final slash in API env): $($outputs.GatewayBaseUrl.TrimEnd('/'))"
  Write-Host "Gateway enabled: $enabled. API media flag is unchanged; finish the smoke checks in docs/ambatupost-phase-4.md."
} finally {
  $env:AWS_PROFILE = $previousProfile
  $env:AWS_REGION = $previousRegion
  Pop-Location
}
