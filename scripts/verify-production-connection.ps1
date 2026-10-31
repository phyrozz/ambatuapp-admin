# Read-only check of the production server role and the database TLS certificate.
# Run from a trusted terminal; psql prompts for the role password without echoing it.
$ErrorActionPreference = 'Stop'
$poolerHost = (Read-Host 'Supabase production session pooler host').Trim()
$projectRef = (Read-Host 'Supabase production project reference').Trim()
$certificatePath = (Read-Host 'Path to the downloaded production database certificate').Trim().Trim('"')

if ($poolerHost -cnotmatch '^aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com$' -or $projectRef -cnotmatch '^[a-z0-9]{1,64}$') {
    throw 'Invalid session pooler host or project reference.'
}
if (-not (Test-Path -LiteralPath $certificatePath -PathType Leaf)) {
    throw 'Certificate file was not found.'
}

$names = @('PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGSSLMODE', 'PGSSLROOTCERT', 'PGPASSWORD')
$previous = @{}
foreach ($name in $names) { $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
try {
    $env:PGHOST = $poolerHost
    $env:PGPORT = '5432'
    $env:PGDATABASE = 'postgres'
    $env:PGUSER = "ambatu_prod_content_reader.$projectRef"
    $env:PGSSLMODE = 'verify-full'
    $env:PGSSLROOTCERT = (Resolve-Path -LiteralPath $certificatePath).Path
    Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
    psql -X -W -v ON_ERROR_STOP=1 -c "SELECT source_project, source_count FROM app.migration_runs WHERE id='firestore-prod-v1' AND source_project='ambatuapp-bcebb';"
    if ($LASTEXITCODE -ne 0) { throw 'Production database connection check failed.' }
} finally {
    foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process') }
}
