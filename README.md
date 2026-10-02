# Conversation Favicons

**A Thunderbird add-on that shows the favicons of the companies involved next to senders, conversations, calendar events and contacts, so you see at a glance who a conversation is with.**

Icons come from the email domains of the people involved. Identical icons are shown only once.

## Where it shows icons

- **Message list (cards view):** favicons of every domain in the conversation (senders, To and Cc), with your own domains hidden.
- **Message header:** next to each person in From, To and Cc.
- **Conversation view:** next to each sender.
- **Calendar:** next to event titles (Events pane, day, week, multiweek and month views), based on organizer and attendees.
- **Address book:** next to each contact's name.

## What you can do

- **Tag a conversation with companies:** right-click it → *Assign company domains…*. Replies are tagged automatically.
- **Tag calendar events** the same way from the event's context menu.
- **Custom favicons** for any domain (image file, image URL, or "same as another domain").
- **Ignore domains**, limit the number of icons, and turn each place on or off.

## Privacy

Nothing is sent anywhere until you allow it on the consent page shown after installing. With your consent the add-on sends **only domain names** (e.g. `company.com`) to Google, or DuckDuckGo as a fallback, to download favicons. No message content, names or email addresses are sent. Favicons are cached locally for up to 30 days. Without consent, domains show as coloured initials and custom favicons still work.

## Install

1. Download the latest `.xpi` from [Releases](../../releases/latest).
2. Thunderbird → Tools → Add-ons and Themes → ⚙ → *Install Add-on From File…*

Compatible with Thunderbird 128 – 157. It uses Experiment APIs (no built-in API can change the message list, header, calendar or address book), so it is distributed here and not on addons.thunderbird.net, and it may need an update when Thunderbird changes those parts of its interface.

Thunderbird only installs unsigned add-ons permanently if `xpinstall.signatures.required` can be set to `false` (ESR/Beta/Daily). Otherwise use *Debug Add-ons → Load Temporary Add-on*.

## Releasing

Bump `version` in `manifest.json`, commit, then `git tag vX.Y.Z && git push --tags`. The GitHub Action builds the XPI and publishes the release. Local build: `./build.ps1`.

## License

[MIT](LICENSE)
