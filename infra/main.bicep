targetScope = 'resourceGroup'

@description('Name reserved for this game; never an existing unrelated app.')
param appName string = 'hearthlands-online'

param location string = 'centralindia'
param environmentResourceGroup string = 'growth-tracker-rg'
param environmentName string = 'growth-tracker-env'
param registryResourceGroup string = 'growth-tracker-rg'
param registryName string = 'growthtrackeracr'

@description('An immutable Hearthlands image tag or digest in the existing registry.')
param image string

@description('Unique revision suffix for this release. Deactivate the previous game revision before upgrading.')
@minLength(1)
@maxLength(40)
param revisionSuffix string

@secure()
@minLength(1)
@description('Least-privileged connection to the dedicated Hearthlands PostgreSQL database. Never an unrelated application database.')
param databaseUrl string

@description('Game-owned schema inside the dedicated database.')
param databaseSchema string = 'hearthlands_game'

@description('Existing verified domain bindings. Preserve these on full template deployments; override with [] only for a new environment without a bound hostname.')
param customDomainBindings array = loadJsonContent('custom-domains.json')

resource environment 'Microsoft.App/managedEnvironments@2025-01-01' existing = {
  scope: resourceGroup(environmentResourceGroup)
  name: environmentName
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  scope: resourceGroup(registryResourceGroup)
  name: registryName
}

resource imageIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${appName}-image-pull'
  location: location
  tags: {
    application: 'hearthlands-online'
  }
}

module imageAccess './registry-access.bicep' = {
  name: '${appName}-registry-access'
  scope: resourceGroup(registryResourceGroup)
  params: {
    registryName: registryName
    principalId: imageIdentity.properties.principalId
    identityResourceId: imageIdentity.id
  }
}

resource app 'Microsoft.App/containerApps@2025-01-01' = {
  name: appName
  location: location
  tags: {
    application: 'hearthlands-online'
  }
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${imageIdentity.id}': {}
    }
  }
  properties: {
    environmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      // Stop-before-start releases avoid overlapping database coordinators.
      activeRevisionsMode: 'Multiple'
      ingress: {
        external: true
        targetPort: 3000
        transport: 'auto'
        allowInsecure: false
        customDomains: customDomainBindings
        traffic: [
          {
            latestRevision: true
            weight: 100
          }
        ]
      }
      registries: [
        {
          server: registry.properties.loginServer
          identity: imageIdentity.id
        }
      ]
      secrets: [
        {
          name: 'database-url'
          value: databaseUrl
        }
      ]
    }
    template: {
      revisionSuffix: revisionSuffix
      terminationGracePeriodSeconds: 60
      scale: {
        minReplicas: 1
        maxReplicas: 1
      }
      containers: [
        {
          name: 'game'
          image: image
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
          env: [
            { name: 'NODE_ENV', value: 'production' }
            { name: 'HOST', value: '0.0.0.0' }
            { name: 'PORT', value: '3000' }
            { name: 'DATABASE_URL', secretRef: 'database-url' }
            { name: 'DATABASE_SCHEMA', value: databaseSchema }
            { name: 'DATABASE_SSL', value: 'require' }
            { name: 'ROOM_RETENTION_DAYS', value: '3650' }
          ]
          probes: [
            {
              type: 'Startup'
              httpGet: { path: '/health', port: 3000, scheme: 'HTTP' }
              periodSeconds: 5
              timeoutSeconds: 3
              failureThreshold: 60
            }
            {
              type: 'Readiness'
              httpGet: { path: '/health', port: 3000, scheme: 'HTTP' }
              periodSeconds: 10
              timeoutSeconds: 5
              failureThreshold: 3
            }
            {
              // A transient database outage should not kill an otherwise healthy process.
              type: 'Liveness'
              tcpSocket: { port: 3000 }
              periodSeconds: 30
              timeoutSeconds: 3
              failureThreshold: 3
            }
          ]
        }
      ]
    }
  }
  dependsOn: [
    imageAccess
  ]
}

output appResourceId string = app.id
output gameUrl string = 'https://${app.properties.configuration.ingress.fqdn}'
output customGameUrl string = empty(customDomainBindings) ? '' : 'https://${customDomainBindings[0].name}'
