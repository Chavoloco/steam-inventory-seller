import * as readline from 'readline';
require('dotenv').config();
const SteamTotp = require('steam-totp');
const {LoginSession, EAuthTokenPlatformType} = require('steam-session');


const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(query: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(query, resolve);
  });
}

async function main() {
  const username = process.env.STEAM_USERNAME || await question('Steam username: ');
  const password = process.env.STEAM_PASSWORD || await question('Steam password: ');
  const appidStr = process.env.STEAM_APPID || await question('App ID (e.g., 753 for STEAM): ');
  const contextidStr = process.env.STEAM_CONTEXTID || await question('Context ID (e.g., 6 for steam): ');
  const sharedSecret = await question('Steam shared secret or 2FA code (leave empty if none): ');

  if (!username || !password) {
    throw new Error('Steam username and password are required. Set STEAM_USERNAME and STEAM_PASSWORD in .env or enter them when prompted.');
  }

  const appid = parseInt(appidStr);
  const contextid = parseInt(contextidStr);

  // Use steam-session for login to handle mobile confirmation
  const session = new LoginSession(EAuthTokenPlatformType.WebBrowser);

  function getSteamGuardCode(secret: string): string | undefined {
    const input = secret.trim();
    if (!input) return undefined;
    // Accept either a direct 2FA code or the shared secret used by steam-totp.
    return input.length === 5 ? input : SteamTotp.generateAuthCode(input);
  }

  session.on('authenticated', async () => {
    try {
      const webCookies = await session.getWebCookies();
      const cookiesStr = webCookies.join('; ');
      console.log('Logged in successfully');

      // Get steamid
      const profileResponse = await fetch('https://steamcommunity.com/my/profile', {
        headers: {
          'Cookie': cookiesStr,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        },
        redirect: 'manual'
      });
      const location = profileResponse.headers.get('location');
      if (!location) {
        throw new Error('Failed to get steamid');
      }
      const steamId = location.split('/')[4];

      // Get inventory
      const inventoryUrl = `https://steamcommunity.com/inventory/${steamId}/${appid}/${contextid}?l=english`;
      const inventoryResponse = await fetch(inventoryUrl, {
        headers: {
          'Cookie': cookiesStr,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
      });
      if (!inventoryResponse.ok) {
        throw new Error(`Failed to get inventory: ${inventoryResponse.status}`);
      }
      const inventoryData = await inventoryResponse.json() as any;
      const assets = inventoryData.assets || [];
      const descriptions = inventoryData.descriptions || [];
      const descMap = new Map<string, any>();
      for (const desc of descriptions) {
        const key = `${desc.classid}_${desc.instanceid}`;
        descMap.set(key, desc);
      }
      const marketableItems: any[] = [];
      for (const asset of assets) {
        const key = `${asset.classid}_${asset.instanceid}`;
        const desc = descMap.get(key);
        if (desc && desc.marketable && desc.market_hash_name) {
          marketableItems.push({ ...asset, market_hash_name: desc.market_hash_name });
        }
      }
      console.log(`Found ${assets.length} items in inventory, ${marketableItems.length} marketable`);

      // Sell each item
      await sellItems(webCookies, marketableItems, appid, steamId);
      console.log('Finished selling');
      rl.close();
    } catch (ex) {
      console.error('Error after authentication:', ex);
      rl.close();
    }
  });

  session.on('error', (err: any) => {
    console.error('Login failed:', err);
    rl.close();
  });

  try {
    let startResult = await session.startWithCredentials({
      accountName: username,
      password: password,
      steamGuardCode: getSteamGuardCode(sharedSecret)
    });

    if (startResult.actionRequired) {
      console.log('Mobile confirmation required. Please check your Steam mobile app and approve the login.');
    }
  } catch (ex: any) {
    if (ex.code === 429) {
      const retryDelays = [30000, 60000, 120000];
      for (let i = 0; i < retryDelays.length; i++) {
        const delayMs = retryDelays[i];
        console.log(`Rate limited by Steam. Waiting ${delayMs / 1000} seconds before retrying...`);
        await delay(delayMs);

        try {
          const startResult = await session.startWithCredentials({
            accountName: username,
            password: password,
            steamGuardCode: getSteamGuardCode(sharedSecret)
          });
          if (startResult.actionRequired) {
            console.log('Mobile confirmation required. Please check your Steam mobile app and approve the login.');
          }
          return;
        } catch (retryEx: any) {
          if (retryEx.code !== 429 || i === retryDelays.length - 1) {
            console.error('Failed to start login after retry:', retryEx);
            rl.close();
            return;
          }
          console.log(`Still rate limited after retry ${i + 1}.`);
        }
      }
    } else {
      console.error('Failed to start login:', ex);
      rl.close();
      return;
    }
  }
}

async function sellItems(cookies: string[], items: any[], appid: number, steamId: string) {
  const cookiesStr = cookies.join('; ');
  for (const item of items) {
    try {
      const price = await getRecommendedPrice(cookiesStr, appid, item.market_hash_name);

      if (price !== null) {
        await sellItem(cookiesStr, item, price, appid, steamId);
        console.log(`Sold ${item.market_hash_name} for ${price} cents`);
        // Delay to avoid rate limits
        await delay(2000);
      } else {
        console.log(`No price found for ${item.market_hash_name}`);
      }
    } catch (error) {
      console.error(`Failed to sell ${item.market_hash_name}:`, error);
    }
  }
}

async function getRecommendedPrice(cookiesStr: string, appid: number, marketHashName: string): Promise<number | null> {
  const priceUrl = `https://steamcommunity.com/market/priceoverview/?appid=${appid}&market_hash_name=${encodeURIComponent(marketHashName)}&currency=1`;
  const response = await fetch(priceUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      'Accept': 'application/json'
    }
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '<no body>');
    console.warn(`priceoverview fetch failed (${response.status}) for "${marketHashName}": ${body}`);
    return null;
  }

  const data = await response.json() as any;
  console.log('priceoverview response:', data);

  if (!data?.success) return null;

  const priceField = data.lowest_price ?? data.median_price;
  if (!priceField) return null;

  const normalized = String(priceField).replace(/[^\d.]/g, '');
  const floatVal = parseFloat(normalized);
  if (isNaN(floatVal)) return null;
  return Math.round(floatVal * 100);
}

async function sellItem(cookiesStr: string, item: any, price: number | string, appid: number, steamId: string): Promise<void> {
    console.log(`Selling item ${item.market_hash_name} at price ${price} cents`);
    const sellUrl = 'https://steamcommunity.com/market/sellitem/';
    
    // Extract sessionid from cookies more reliably
    const sessionidMatch = cookiesStr.match(/sessionid=([^;]+)/);
    const sessionid = sessionidMatch ? sessionidMatch[1] : '000000000000000000000000';
    
    const formData = new URLSearchParams();
    formData.append('sessionid', sessionid);
    formData.append('appid', item.appid.toString());
    formData.append('contextid', item.contextid.toString());
    formData.append('assetid', item.assetid || item.id);
    formData.append('amount', '1');
    formData.append('price', price.toString());

    const response = await fetch(sellUrl, {
        method: 'POST',
        headers: {
            'Cookie': cookiesStr,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            'Content-Type': 'application/x-www-form-urlencoded',
            'Referer': `https://steamcommunity.com/profiles/${steamId}/inventory/`,
            'Origin': 'https://steamcommunity.com'
        },
        body: formData.toString()
    });

    if (!response.ok) {
        throw new Error(`Sell failed: ${response.status}`);
    }

    const data = await response.json() as any;
    if (!data || !data.success) {
        throw new Error(`Sell failed: ${data?.message || 'Unknown error'}`);
    }
}

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main();