const { EventEmitter } = require('events');
const ethUtil = require('ethereumjs-util');
// const HDKey = require('hdkey');
const { TransactionFactory } = require('@ethereumjs/tx');
const { SecuxTransactionTool } = require("@secux/protocol-transaction");
const { SecuxETH } = require("@secux/app-eth");
const hdPathString = `m/44'/60'/0'/0/0`;
const keyringType = 'Secux Hardware';
const pathBase = 'm';
const MAX_INDEX = 1000;
const DELAY_BETWEEN_POPUPS = 1000;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SecuxKeyring extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.type = keyringType;
    this.accounts = [];
    this.hdk = null;
    this.page = 0;
    this.perPage = 5;
    this.unlockedAccount = 0;
    this.paths = {};
    this.device = opts.device
    this.deserialize(opts);
  }

  serialize() {
    return Promise.resolve({
      hdPath: this.hdPath,
      accounts: this.accounts,
      page: this.page,
      paths: this.paths,
      perPage: this.perPage,
      unlockedAccount: this.unlockedAccount,
    });
  }

  deserialize(opts = {}) {
    this.hdPath = opts.hdPath || hdPathString;
    this.accounts = opts.accounts || [];
    this.page = opts.page || 0;
    this.perPage = opts.perPage || 5;
    return Promise.resolve();
  }

  isUnlocked() {
    return Boolean(this.hdk && this.hdk.publicKey);
  }

  unlock() {
    if (this.isUnlocked()) {
      return Promise.resolve('already unlocked');
    }
    return new Promise((resolve, reject) => {
      this.device.getXPublickey(this.hdPath)
        .then((response) => {
          if (response.success) {
            this.hdk.publicKey = Buffer.from(response.payload.publicKey, 'hex');
            this.hdk.chainCode = Buffer.from(response.payload.chainCode, 'hex');
            resolve('just unlocked');
          } else {
            reject(
              new Error(
                (response.payload && response.payload.error) || 'Unknown error',
              ),
            );
          }
        })
        .catch((e) => {
          reject(new Error((e && e.toString()) || 'Unknown error'));
        });
    });
  }

  setAccountToUnlock(index) {
    this.unlockedAccount = parseInt(index, 10);
  }

  addAccounts(n = 1) {
    return new Promise((resolve, reject) => {
      this.unlock()
        .then((_) => {
          const from = this.unlockedAccount;
          const to = from + n;

          for (let i = from; i < to; i++) {
            const address = this._addressFromIndex(pathBase, i);
            if (!this.accounts.includes(address)) {
              this.accounts.push(address);
            }
            this.page = 0;
          }
          resolve(this.accounts);
        })
        .catch((e) => {
          reject(e);
        });
    });
  }

  getFirstPage() {
    this.page = 0;
    return this.__getPage(1);
  }

  getNextPage() {
    return this.__getPage(1);
  }

  getPreviousPage() {
    return this.__getPage(-1);
  }

  __getPage(increment) {
    this.page += increment;

    if (this.page <= 0) {
      this.page = 1;
    }

    return new Promise((resolve, reject) => {
      this.unlock()
        .then((_) => {
          const from = (this.page - 1) * this.perPage;
          const to = from + this.perPage;

          const accounts = [];

          for (let i = from; i < to; i++) {
            const address = this._addressFromIndex(pathBase, i);
            accounts.push({
              address,
              balance: null,
              index: i,
            });
            this.paths[ethUtil.toChecksumAddress(address)] = i;
          }
          resolve(accounts);
        })
        .catch((e) => {
          reject(e);
        });
    });
  }

  async getAccounts() {
    const address = await SecuxETH.getAddress(this.device, this.hdPath);
    this.accounts = [address];
    console.log(this.accounts.slice())
    // return this.accounts.slice()
    return Promise.resolve(this.accounts.slice());
  }

  removeAccount(address) {
    if (
      !this.accounts.map((a) => a.toLowerCase()).includes(address.toLowerCase())
    ) {
      throw new Error(`Address ${address} not found in this keyring`);
    }
    this.accounts = this.accounts.filter(
      (a) => a.toLowerCase() !== address.toLowerCase(),
    );
  }

  // tx is an instance of the ethereumjs-transaction class.
  async signTransaction(address, tx) {
    const txData = tx.toJSON();
    txData.type = tx.type;

    const response = await SecuxETH.signTransaction(
      this.device,
      this.hdPath,
      {
        chainId: txData.chainId,
        nonce: txData.nonce,
        maxPriorityFeePerGas: txData.maxPriorityFeePerGas,
        maxFeePerGas: txData.maxFeePerGas,
        gasLimit: txData.gasLimit,
        to: txData.to,
        value: txData.value,
        accessList: txData.accessList,
        data: txData.data
      }
    );

    txData.r = response.signature.slice(0, 32);
    txData.s = response.signature.slice(32, 64);
    txData.v = response.signature.slice(64);

    const newOrMutatedTx = TransactionFactory.fromTxData(txData, {
      common: tx.common,
      freeze: true,
    });


    const addressSignedWith = ethUtil.toChecksumAddress(
      ethUtil.addHexPrefix(
        newOrMutatedTx.getSenderAddress().toString('hex'),
      ),
    );
    const correctAddress = ethUtil.toChecksumAddress(address);

    console.log(newOrMutatedTx.getSenderAddress().toString('hex'))
    console.log(addressSignedWith)
    
    if (addressSignedWith !== correctAddress) {
      throw new Error("signature doesn't match the right address");
    }
    return newOrMutatedTx;

  }

  signMessage(withAccount, data) {
    return this.signPersonalMessage(withAccount, data);
  }

  // For personal_sign, we need to prefix the message:
  signPersonalMessage(withAccount, message) {
    return new Promise((resolve, reject) => {
      this.unlock()
        .then((status) => {
          setTimeout(
            (_) => {
              SecuxETH.signMessage(
                this.device,
                this._pathFromAddress(withAccount),
                message
              )
                .then((response) => {
                  if (response) {
                    const signature = `0x${response.signature.toString("hex")}`;
                    resolve(signature);
                  } else {
                    reject(
                      new Error(
                        (response.payload && response.payload.error) ||
                        'Unknown error',
                      ),
                    );
                  }
                })
                .catch((e) => {
                  reject(new Error((e && e.toString()) || 'Unknown error'));
                });
              // This is necessary to avoid popup collision
              // between the unlock & sign Secux popups
            },
            status === 'just unlocked' ? DELAY_BETWEEN_POPUPS : 0,
          );
        })
        .catch((e) => {
          reject(new Error((e && e.toString()) || 'Unknown error'));
        });
    });
  }

  signTypedData() {
    // Waiting on Secux to enable this
    return Promise.reject(new Error('Not supported on this device'));
  }

  exportAccount() {
    return Promise.reject(new Error('Not supported on this device'));
  }

  forgetDevice() {
    this.accounts = [];
    this.hdk = new HDKey();
    this.page = 0;
    this.unlockedAccount = 0;
    this.paths = {};
  }

  /* PRIVATE METHODS */

  _normalize(buf) {
    return ethUtil.bufferToHex(buf).toString();
  }

  // eslint-disable-next-line no-shadow
  _addressFromIndex(pathBase, i) {
    const dkey = this.hdk.derive(`${pathBase}/${i}`);
    const address = ethUtil
      .publicToAddress(dkey.publicKey, true)
      .toString('hex');
    return ethUtil.toChecksumAddress(`0x${address}`);
  }

  _pathFromAddress(address) {
    const checksummedAddress = ethUtil.toChecksumAddress(address);
    let index = this.paths[checksummedAddress];
    if (typeof index === 'undefined') {
      for (let i = 0; i < MAX_INDEX; i++) {
        if (checksummedAddress === this._addressFromIndex(pathBase, i)) {
          index = i;
          break;
        }
      }
    }

    if (typeof index === 'undefined') {
      throw new Error('Unknown address');
    }
    return `${this.hdPath}/${index}`;
  }
}

SecuxKeyring.type = keyringType;