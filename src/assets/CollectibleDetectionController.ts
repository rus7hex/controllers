import { BaseController, BaseConfig, BaseState } from '../BaseController';
import type { NetworkState, NetworkType } from '../network/NetworkController';
import type { PreferencesState } from '../user/PreferencesController';
import { safelyExecute, timeoutFetch, toChecksumHexAddress } from '../util';
import { MAINNET } from '../constants';
import type {
  CollectiblesController,
  CollectiblesState,
  CollectibleMetadata,
} from './CollectiblesController';

const DEFAULT_INTERVAL = 180000;

/**
 * @type ApiCollectible
 *
 * Collectible object coming from OpenSea api
 * @property token_id - The collectible identifier
 * @property num_sales - Number of sales
 * @property background_color - The background color to be displayed with the item
 * @property image_url - URI of an image associated with this collectible
 * @property image_preview_url - URI of a smaller image associated with this collectible
 * @property image_thumbnail_url - URI of a thumbnail image associated with this collectible
 * @property image_original_url - URI of the original image associated with this collectible
 * @property animation_url - URI of a animation associated with this collectible
 * @property animation_original_url - URI of the original animation associated with this collectible
 * @property name - The collectible name
 * @property description - The collectible description
 * @property external_link - External link containing additional information
 * @property assetContract - The collectible contract information object
 * @property creator - The collectible owner information object
 * @property lastSale - When this item was last sold
 * @property collection - Collectible collection data object.
 */
export interface ApiCollectible {
  token_id: string;
  num_sales: number | null;
  background_color: string | null;
  image_url: string | null;
  image_preview_url: string | null;
  image_thumbnail_url: string | null;
  image_original_url: string | null;
  animation_url: string | null;
  animation_original_url: string | null;
  name: string | null;
  description: string | null;
  external_link: string | null;
  asset_contract: ApiCollectibleContract;
  creator: ApiCollectibleCreator;
  last_sale: ApiCollectibleLastSale | null;
  collection: ApiCollectibleCollection;
}

/**
 * @type ApiCollectibleContract
 *
 * Collectible contract object coming from OpenSea api
 * @property address - Address of the collectible contract
 * @property asset_contract_type - The collectible type, it could be `semi-fungible` or `non-fungible`
 * @property created_date - Creation date
 * @property name - The collectible contract name
 * @property schema_name - The schema followed by the contract, it could be `ERC721` or `ERC1155`
 * @property symbol - The collectible contract symbol
 * @property total_supply - Total supply of collectibles
 * @property description - The collectible contract description
 * @property external_link - External link containing additional information
 * @property image_url - URI of an image associated with this collectible contract
 */
export interface ApiCollectibleContract {
  address: string;
  asset_contract_type: string | null;
  created_date: string | null;
  name: string | null;
  schema_name: string | null;
  symbol: string | null;
  total_supply: string | null;
  description: string | null;
  external_link: string | null;
  image_url: string | null;
}

/**
 * @type ApiCollectibleLastSale
 *
 * Collectible sale object coming from OpenSea api
 * @property event_timestamp - Object containing a `username`
 * @property total_price - URI of collectible image associated with this owner
 * @property transaction - Object containing transaction_hash and block_hash
 */
export interface ApiCollectibleLastSale {
  event_timestamp: string;
  total_price: string;
  transaction: { transaction_hash: string; block_hash: string };
}

/**
 * @type ApiCollectibleCreator
 *
 * Collectible creator object coming from OpenSea api
 * @property user - Object containing a `username`
 * @property profile_img_url - URI of collectible image associated with this owner
 * @property address - The owner address
 */
export interface ApiCollectibleCreator {
  user: { username: string };
  profile_img_url: string;
  address: string;
}

/**
 * @type ApiCollectibleCollection
 *
 * Collectible collection object from OpenSea api.
 * @property name - Collection name.
 * @property image_url - URI collection image.
 */
export interface ApiCollectibleCollection {
  name: string;
  image_url: string;
}

/**
 * @type CollectibleDetectionConfig
 *
 * CollectibleDetection configuration
 * @property interval - Polling interval used to fetch new token rates
 * @property networkType - Network type ID as per net_version
 * @property selectedAddress - Vault selected address
 * @property tokens - List of tokens associated with the active vault
 */
export interface CollectibleDetectionConfig extends BaseConfig {
  interval: number;
  networkType: NetworkType;
  selectedAddress: string;
}

/**
 * Controller that passively polls on a set interval for Collectibles auto detection
 */
export class CollectibleDetectionController extends BaseController<
  CollectibleDetectionConfig,
  BaseState
> {
  private intervalId?: NodeJS.Timeout;

  private getOwnerCollectiblesApi(address: string, offset: number) {
    return `https://api.opensea.io/api/v1/assets?owner=${address}&offset=${offset}&limit=50`;
  }

  private async getOwnerCollectibles() {
    const { selectedAddress } = this.config;
    let response: Response;
    let collectibles: any = [];
    const openSeaApiKey = this.getOpenSeaApiKey();
    try {
      let offset = 0;
      let pagingFinish = false;
      /* istanbul ignore if */
      do {
        const api = this.getOwnerCollectiblesApi(selectedAddress, offset);
        response = await timeoutFetch(
          api,
          openSeaApiKey ? { headers: { 'X-API-KEY': openSeaApiKey } } : {},
          15000,
        );
        const collectiblesArray = await response.json();
        collectiblesArray.assets?.length !== 0
          ? (collectibles = [...collectibles, ...collectiblesArray.assets])
          : (pagingFinish = true);
        offset += 50;
      } while (!pagingFinish);
    } catch (e) {
      /* istanbul ignore next */
      return [];
    }
    return collectibles;
  }

  /**
   * Name of this controller used during composition
   */
  name = 'CollectibleDetectionController';

  private getOpenSeaApiKey: () => string | undefined;

  private addCollectible: CollectiblesController['addCollectible'];

  private getCollectiblesState: () => CollectiblesState;

  /**
   * Creates a CollectibleDetectionController instance.
   *
   * @param options - The controller options.
   * @param options.onCollectiblesStateChange - Allows subscribing to assets controller state changes.
   * @param options.onPreferencesStateChange - Allows subscribing to preferences controller state changes.
   * @param options.onNetworkStateChange - Allows subscribing to network controller state changes.
   * @param options.getOpenSeaApiKey - Gets the OpenSea API key, if one is set.
   * @param options.addCollectible - Add a collectible.
   * @param options.getCollectiblesState - Gets the current state of the Assets controller.
   * @param config - Initial options used to configure this controller.
   * @param state - Initial state to set on this controller.
   */
  constructor(
    {
      onPreferencesStateChange,
      onNetworkStateChange,
      getOpenSeaApiKey,
      addCollectible,
      getCollectiblesState,
    }: {
      onCollectiblesStateChange: (
        listener: (collectiblesState: CollectiblesState) => void,
      ) => void;
      onPreferencesStateChange: (
        listener: (preferencesState: PreferencesState) => void,
      ) => void;
      onNetworkStateChange: (
        listener: (networkState: NetworkState) => void,
      ) => void;
      getOpenSeaApiKey: () => string | undefined;
      addCollectible: CollectiblesController['addCollectible'];
      getCollectiblesState: () => CollectiblesState;
    },
    config?: Partial<CollectibleDetectionConfig>,
    state?: Partial<BaseState>,
  ) {
    super(config, state);
    this.defaultConfig = {
      interval: DEFAULT_INTERVAL,
      networkType: MAINNET,
      selectedAddress: '',
    };
    this.initialize();
    this.getCollectiblesState = getCollectiblesState;
    onPreferencesStateChange(({ selectedAddress }) => {
      const actualSelectedAddress = this.config.selectedAddress;
      if (selectedAddress !== actualSelectedAddress) {
        this.configure({ selectedAddress });
        this.detectCollectibles();
      }
    });

    onNetworkStateChange(({ provider }) => {
      this.configure({ networkType: provider.type });
    });
    this.getOpenSeaApiKey = getOpenSeaApiKey;
    this.addCollectible = addCollectible;
  }

  /**
   * Start polling for the currency rate.
   */
  async start() {
    if (!this.isMainnet() || this.disabled) {
      return;
    }

    await this.startPolling();
  }

  /**
   * Stop polling for the currency rate.
   */
  stop() {
    this.stopPolling();
  }

  private stopPolling() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }
  }

  /**
   * Starts a new polling interval.
   *
   * @param interval - An interval on which to poll.
   */
  private async startPolling(interval?: number): Promise<void> {
    interval && this.configure({ interval }, false, false);
    this.stopPolling();
    await this.detectCollectibles();
    this.intervalId = setInterval(async () => {
      await this.detectCollectibles();
    }, this.config.interval);
  }

  /**
   * Checks whether network is mainnet or not.
   *
   * @returns Whether current network is mainnet.
   */
  isMainnet = (): boolean => this.config.networkType === MAINNET;

  /**
   * Triggers asset ERC721 token auto detection on mainnet. Any newly detected collectibles are
   * added.
   */
  async detectCollectibles() {
    /* istanbul ignore if */
    if (!this.isMainnet() || this.disabled) {
      return;
    }
    const requestedSelectedAddress = this.config.selectedAddress;

    /* istanbul ignore else */
    if (!requestedSelectedAddress) {
      return;
    }

    await safelyExecute(async () => {
      const apiCollectibles = await this.getOwnerCollectibles();
      const addCollectiblesPromises = apiCollectibles.map(
        async (collectible: ApiCollectible) => {
          const {
            token_id,
            num_sales,
            background_color,
            image_url,
            image_preview_url,
            image_thumbnail_url,
            image_original_url,
            animation_url,
            animation_original_url,
            name,
            description,
            external_link,
            creator,
            asset_contract: { address, schema_name },
            collection,
            last_sale,
          } = collectible;

          let ignored;
          /* istanbul ignore else */
          const { ignoredCollectibles } = this.getCollectiblesState();
          if (ignoredCollectibles.length) {
            ignored = ignoredCollectibles.find((c) => {
              /* istanbul ignore next */
              return (
                c.address === toChecksumHexAddress(address) &&
                c.tokenId === token_id
              );
            });
          }

          /* istanbul ignore else */
          if (
            !ignored &&
            requestedSelectedAddress === this.config.selectedAddress
          ) {
            /* istanbul ignore next */
            const collectibleMetadata: CollectibleMetadata = Object.assign(
              {},
              { name },
              creator && { creator },
              description && { description },
              image_url && { image: image_url },
              num_sales && { numberOfSales: num_sales },
              background_color && { backgroundColor: background_color },
              image_preview_url && { imagePreview: image_preview_url },
              image_thumbnail_url && { imageThumbnail: image_thumbnail_url },
              image_original_url && { imageOriginal: image_original_url },
              animation_url && { animation: animation_url },
              animation_original_url && {
                animationOriginal: animation_original_url,
              },
              schema_name && { standard: schema_name },
              external_link && { externalLink: external_link },
              last_sale && { lastSale: last_sale },
              collection.name && { collectionName: collection.name },
              collection.image_url && {
                collectionImage: collection.image_url,
              },
            );
            await this.addCollectible(
              address,
              token_id,
              collectibleMetadata,
              true,
            );
          }
        },
      );
      await Promise.all(addCollectiblesPromises);
    });
  }
}

export default CollectibleDetectionController;
