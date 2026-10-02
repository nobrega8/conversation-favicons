# Conversation Favicons

Thunderbird add-on (needs an Experiment API, so it is distributed here instead of addons.thunderbird.net).

## Install

1. Download the latest `.xpi` from [Releases](../../releases/latest).
2. Thunderbird → Tools → Add-ons and Themes → ⚙ → *Install Add-on From File…*

Note: Thunderbird only installs unsigned add-ons permanently if `xpinstall.signatures.required` can be set to `false` (ESR/Beta/Daily). Otherwise use *Debug Add-ons → Load Temporary Add-on*.

## Release

Bump `version` in `manifest.json`, commit, then:

```
git tag vX.Y.Z && git push --tags
```

The workflow builds the XPI and publishes the release. Local build: `./build.ps1`.
