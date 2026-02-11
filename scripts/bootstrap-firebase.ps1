param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectId,

  [Parameter(Mandatory = $true)]
  [string]$BillingAccount,

  [string]$ProjectName = "AI Board Transformation",
  [string]$Region = "us-central1",
  [string]$WebAppDisplayName = "ai-board-transformation-web",
  [switch]$SkipCreateProject,
  [switch]$SkipNpmInstall,
  [switch]$SkipDeploy
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Assert-Command {
  param([string]$Name)
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Missing required command: $Name"
  }
}

function ConvertFrom-JsonSafe {
  param([string]$Text)

  $trimmed = $Text.Trim()
  $firstBrace = $trimmed.IndexOf("{")
  $lastBrace = $trimmed.LastIndexOf("}")
  if ($firstBrace -lt 0 -or $lastBrace -lt 0 -or $lastBrace -lt $firstBrace) {
    throw "Expected JSON output but got: $trimmed"
  }

  $json = $trimmed.Substring($firstBrace, ($lastBrace - $firstBrace + 1))
  return $json | ConvertFrom-Json
}

function Invoke-External {
  param(
    [string]$Label,
    [scriptblock]$Command,
    [string[]]$AllowedFailurePatterns = @()
  )

  Write-Step $Label
  $output = & $Command 2>&1
  $code = $LASTEXITCODE
  $text = ($output | Out-String).Trim()

  if ($code -ne 0) {
    foreach ($pattern in $AllowedFailurePatterns) {
      if ($text -match $pattern) {
        Write-Host $text
        return $text
      }
    }
    throw "$Label failed with exit code $code.`n$text"
  }

  if ($text) {
    Write-Host $text
  }

  return $text
}

function Resolve-FirebaseResult {
  param($JsonObject)

  if ($null -eq $JsonObject) {
    return $null
  }

  $hasResult = $false
  if ($JsonObject -is [System.Collections.IDictionary]) {
    $hasResult = $JsonObject.Contains("result")
  }
  else {
    $hasResult = $JsonObject.PSObject.Properties.Name -contains "result"
  }

  if ($hasResult) {
    return $JsonObject.result
  }

  return $JsonObject
}

function Get-EnabledServices {
  param([string]$ProjectIdValue)

  $lines = & gcloud services list --enabled --project $ProjectIdValue --format="value(config.name)" 2>$null
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to list enabled services for project '$ProjectIdValue'."
  }

  $set = New-Object "System.Collections.Generic.HashSet[string]"
  foreach ($line in $lines) {
    $trimmed = [string]$line
    if (-not [string]::IsNullOrWhiteSpace($trimmed)) {
      [void]$set.Add($trimmed.Trim())
    }
  }
  return $set
}

function Ensure-ServiceEnabled {
  param(
    [string]$ProjectIdValue,
    [string]$ServiceName,
    [System.Collections.Generic.HashSet[string]]$EnabledSet
  )

  if ($EnabledSet.Contains($ServiceName)) {
    Write-Host "Service already enabled: $ServiceName"
    return
  }

  $enableOutput = & gcloud services enable $ServiceName --project $ProjectIdValue 2>&1
  if ($LASTEXITCODE -ne 0) {
    $refreshSet = Get-EnabledServices -ProjectIdValue $ProjectIdValue
    if ($refreshSet.Contains($ServiceName)) {
      Write-Host "Service became enabled despite non-zero exit: $ServiceName"
      return
    }
    $text = ($enableOutput | Out-String).Trim()
    throw "Failed to enable service '$ServiceName'.`n$text"
  }

  [void]$EnabledSet.Add($ServiceName)
  Write-Host "Enabled service: $ServiceName"
}

function Update-FirebaseConfigFile {
  param(
    [string]$FilePath,
    [hashtable]$Config
  )

  $content = Get-Content -Path $FilePath -Raw
  $pattern = 'const firebaseConfig = window\.__FIREBASE_CONFIG__ \|\| \{[\s\S]*?\n  \};'

  if (-not [regex]::IsMatch($content, $pattern)) {
    throw "Could not find firebase config block in $FilePath"
  }

  $storageBucket = [string]$Config.storageBucket
  if ([string]::IsNullOrWhiteSpace($storageBucket)) {
    $storageBucket = "$($Config.projectId).appspot.com"
  }

  $replacementLines = @(
    "  const firebaseConfig = window.__FIREBASE_CONFIG__ || {",
    "    apiKey: ""$($Config.apiKey)"",",
    "    authDomain: ""$($Config.authDomain)"",",
    "    projectId: ""$($Config.projectId)"",",
    "    storageBucket: ""$storageBucket"",",
    "    messagingSenderId: ""$($Config.messagingSenderId)"",",
    "    appId: ""$($Config.appId)"",",
    "  };"
  )
  $replacement = [string]::Join("`n", $replacementLines)
  $updated = [regex]::Replace($content, $pattern, $replacement, 1)

  Set-Content -Path $FilePath -Value $updated -Encoding utf8
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Push-Location $repoRoot

try {
  Assert-Command "gcloud"
  Assert-Command "firebase"
  Assert-Command "npm"

  Write-Step "Using repo root: $repoRoot"

  $projectExists = $false
  $projectDescribeOutput = & gcloud projects describe $ProjectId --format=json 2>$null
  if ($LASTEXITCODE -eq 0 -and $projectDescribeOutput) {
    $projectExists = $true
  }

  if (-not $projectExists) {
    if ($SkipCreateProject) {
      throw "Project '$ProjectId' does not exist and -SkipCreateProject was set."
    }
    Invoke-External -Label "Creating GCP project '$ProjectId'" -Command {
      gcloud projects create $ProjectId --name $ProjectName
    } | Out-Null
  }
  else {
    Write-Step "Project '$ProjectId' already exists"
  }

  Invoke-External -Label "Setting gcloud active project" -Command {
    gcloud config set project $ProjectId
  } | Out-Null

  Invoke-External -Label "Linking billing account" -Command {
    gcloud billing projects link $ProjectId --billing-account $BillingAccount
  } | Out-Null

  $services = @(
    "firebase.googleapis.com",
    "firebasehosting.googleapis.com",
    "firestore.googleapis.com",
    "identitytoolkit.googleapis.com",
    "securetoken.googleapis.com"
  )
  Write-Step "Enabling required APIs"
  $enabledSet = Get-EnabledServices -ProjectIdValue $ProjectId
  foreach ($service in $services) {
    Ensure-ServiceEnabled -ProjectIdValue $ProjectId -ServiceName $service -EnabledSet $enabledSet
  }

  $firebaseProjectsJsonText = Invoke-External -Label "Checking Firebase project registration" -Command {
    firebase projects:list --json
  }
  $firebaseProjectsRaw = Resolve-FirebaseResult (ConvertFrom-JsonSafe $firebaseProjectsJsonText)
  $firebaseProjects = @()
  if ($firebaseProjectsRaw -is [System.Array]) {
    $firebaseProjects = $firebaseProjectsRaw
  }
  elseif ($null -ne $firebaseProjectsRaw) {
    $firebaseProjects = @($firebaseProjectsRaw)
  }

  $isFirebaseProject = $false
  foreach ($entry in $firebaseProjects) {
    if ([string]$entry.projectId -eq $ProjectId) {
      $isFirebaseProject = $true
      break
    }
  }

  if ($isFirebaseProject) {
    Write-Step "Project is already a Firebase project"
  }
  else {
    Invoke-External -Label "Adding Firebase to project" -Command {
      firebase projects:addfirebase $ProjectId --non-interactive
    } | Out-Null
  }

  $appsJsonText = Invoke-External -Label "Listing web apps" -Command {
    firebase apps:list WEB --project $ProjectId --json
  }
  $appsRaw = Resolve-FirebaseResult (ConvertFrom-JsonSafe $appsJsonText)
  $apps = @()
  if ($appsRaw -is [System.Array]) {
    $apps = $appsRaw
  }
  elseif ($null -ne $appsRaw) {
    $apps = @($appsRaw)
  }

  $webApp = $apps | Where-Object { $_.displayName -eq $WebAppDisplayName } | Select-Object -First 1
  if ($null -eq $webApp) {
    $webApp = $apps | Select-Object -First 1
  }

  if ($null -eq $webApp) {
    $createAppJsonText = Invoke-External -Label "Creating Firebase web app '$WebAppDisplayName'" -Command {
      firebase apps:create WEB $WebAppDisplayName --project $ProjectId --json
    }
    $createAppResult = Resolve-FirebaseResult (ConvertFrom-JsonSafe $createAppJsonText)
    $appId = [string]$createAppResult.appId
  }
  else {
    $appId = [string]$webApp.appId
    Write-Step "Using existing web app: $appId"
  }

  if ([string]::IsNullOrWhiteSpace($appId)) {
    throw "Unable to resolve Firebase web app id."
  }

  Write-Step "Ensuring default Firestore database exists"
  $dbNames = & gcloud firestore databases list --project $ProjectId --format="value(name)" 2>$null
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to list Firestore databases for project '$ProjectId'."
  }
  $hasDefaultDb = $false
  foreach ($dbName in $dbNames) {
    if ([string]$dbName -match "/databases/\(default\)$") {
      $hasDefaultDb = $true
      break
    }
  }

  if ($hasDefaultDb) {
    Write-Host "Default Firestore database already exists."
  }
  else {
    Invoke-External -Label "Creating default Firestore database" -Command {
      firebase firestore:databases:create "(default)" --location $Region --project $ProjectId
    } | Out-Null
  }

  $accessToken = (Invoke-External -Label "Fetching access token" -Command {
    gcloud auth print-access-token
  }).Trim()
  if ([string]::IsNullOrWhiteSpace($accessToken)) {
    throw "Could not get access token from gcloud."
  }

  $identityHeaders = @{
    Authorization       = "Bearer $accessToken"
    "x-goog-user-project" = $ProjectId
  }

  Write-Step "Initializing Firebase Auth (Identity Platform)"
  try {
    Invoke-RestMethod `
      -Method Post `
      -Uri "https://identitytoolkit.googleapis.com/v2/projects/$ProjectId/identityPlatform:initializeAuth" `
      -Headers $identityHeaders `
      -ContentType "application/json" `
      -Body "{}" | Out-Null
  }
  catch {
    $message = $_.Exception.Message
    $details = ""
    if ($null -ne $_.ErrorDetails -and $null -ne $_.ErrorDetails.Message) {
      $details = [string]$_.ErrorDetails.Message
    }
    $combined = "$message`n$details"
    if ($combined -notmatch "(?i)already been enabled|already initialized|already exists") {
      throw "Auth initialization failed. Ensure billing is enabled for project '$ProjectId'.`n$combined"
    }
  }

  Write-Step "Enabling email/password auth provider"
  $authConfigBody = @{
    name = "projects/$ProjectId/config"
    signIn = @{
      email = @{
        enabled = $true
        passwordRequired = $true
      }
    }
  } | ConvertTo-Json -Depth 8

  Invoke-RestMethod `
    -Method Patch `
    -Uri "https://identitytoolkit.googleapis.com/admin/v2/projects/$ProjectId/config?updateMask=signIn.email.enabled,signIn.email.passwordRequired" `
    -Headers $identityHeaders `
    -ContentType "application/json" `
    -Body $authConfigBody | Out-Null

  $sdkConfigJsonText = Invoke-External -Label "Fetching Firebase SDK config" -Command {
    firebase apps:sdkconfig WEB $appId --project $ProjectId --json
  }
  $sdkConfigRaw = Resolve-FirebaseResult (ConvertFrom-JsonSafe $sdkConfigJsonText)
  $sdkConfig = $sdkConfigRaw
  if ($sdkConfigRaw -isnot [System.Collections.IDictionary] -and ($sdkConfigRaw.PSObject.Properties.Name -contains "sdkConfig")) {
    $sdkConfig = $sdkConfigRaw.sdkConfig
  }
  elseif ($sdkConfigRaw -is [System.Collections.IDictionary] -and $sdkConfigRaw.Contains("sdkConfig")) {
    $sdkConfig = $sdkConfigRaw["sdkConfig"]
  }

  $configMap = @{
    apiKey            = [string]$sdkConfig.apiKey
    authDomain        = [string]$sdkConfig.authDomain
    projectId         = [string]$sdkConfig.projectId
    storageBucket     = [string]$sdkConfig.storageBucket
    messagingSenderId = [string]$sdkConfig.messagingSenderId
    appId             = [string]$sdkConfig.appId
  }

  foreach ($key in @("apiKey", "authDomain", "projectId", "messagingSenderId", "appId")) {
    if ([string]::IsNullOrWhiteSpace($configMap[$key])) {
      throw "SDK config value '$key' is missing."
    }
  }

  Write-Step "Updating .firebaserc"
  $firebaserc = @"
{
  "projects": {
    "default": "$ProjectId"
  }
}
"@
  Set-Content -Path ".firebaserc" -Value $firebaserc -Encoding utf8

  Write-Step "Updating public/firebase-config.js"
  Update-FirebaseConfigFile -FilePath "public/firebase-config.js" -Config $configMap

  if (-not $SkipNpmInstall) {
    Invoke-External -Label "Installing npm dependencies" -Command {
      npm install
    } | Out-Null
  }

  if (-not $SkipDeploy) {
    Invoke-External -Label "Deploying hosting + firestore" -Command {
      npx firebase deploy --project $ProjectId --only "hosting,firestore:rules,firestore:indexes" --force
    } | Out-Null
  }

  Write-Step "Bootstrap complete"
  Write-Host "Project: $ProjectId"
  Write-Host "Web app id: $appId"
  Write-Host "Hosting URL: https://$ProjectId.web.app"
}
finally {
  Pop-Location
}
