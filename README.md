# Steam Inventory Seller

A TypeScript application that uses the Steam API to sell all marketable items from your Steam inventory at the recommended market price.

## Prerequisites

- Node.js (v14 or higher)
- A Steam account with 2FA enabled (recommended for security)
- Your Steam shared secret for 2FA (from Steam Guard mobile app or backup codes)

## Installation

1. Clone or download this repository.
2. Run `npm install` to install dependencies.

## Usage

1. Build the project: `npm run build`
2. Run the application: `npm start`

The application will prompt you for:
- Steam username
- Steam password
- Shared secret (for 2FA, leave empty if not using)
- App ID (e.g., 730 for CS:GO, 440 for Team Fortress 2, 753 for Steam items)
- Context ID (e.g., 2 for CS:GO, 6 for Steam trading cards)

If mobile confirmation is required, the app will wait for you to approve it on your Steam mobile app before proceeding.

It will then log in to Steam, retrieve your inventory for the specified app and context, and attempt to sell all marketable items at the lowest market price.

## Warning

- Selling items on the Steam Market is irreversible.
- Be aware of Steam's rate limits and terms of service.
- This application sells items automatically; use at your own risk.
- Steam may require CAPTCHA or additional verification for selling.

## Dependencies

- steamcommunity: For interacting with Steam Community features
- steam-totp: For generating 2FA codes

## License

ISC