import { connect, Contract, keyStores, Near, WalletConnection } from 'near-api-js'
import { getConfig } from './config'

import { WalletInterface } from './wallet-api/wallet-interface';
import { disconnectedWallet} from './wallet-api/disconnected-wallet';
import { NearWebWallet } from './wallet-api/near-web-wallet/near-web-wallet';
import { narwallets, addNarwalletsListeners } from './wallet-api/narwallets/narwallets';
import { toNumber,ntoy,yton,toStringDec, toStringDecMin, ytonFull, addCommas} from './util/conversions';

import { MetaPool } from './contracts/meta-pool';
import type { ContractState, GetAccountInfoResult, LiquidUnstakeResult, RemoveLiquidityResult} from './contracts/meta-pool-structs';

//qs/qsa are shortcut for document.querySelector/All
import {qs,qsa,qsi,showWait,hideWaitKeepOverlay,showErr,showSuccess,showMessage, show,hide, hidePopup,hideOverlay, qsaInnerText, showError, showPopup} from './util/document';
import { checkRedirectSearchParams } from './wallet-api/near-web-wallet/checkRedirectSearchParams';
import { computeCurrentEpoch, EpochInfo } from './util/near-epoch';

//get global config
//const nearConfig = getConfig(process.env.NODE_ENV || 'development')
let nearConfig = getConfig('testnet'); //default testnet, can change according to URL on window.onload

// global variables used throughout
let wallet:WalletInterface = disconnectedWallet;
let contract:MetaPool;

let metaAccountInfo:GetAccountInfoResult = {} as unknown as GetAccountInfoResult; 
let contractState:ContractState = {} as unknown as ContractState; 

let nearWebWalletConnection:WalletConnection;

//time in ms
const SECONDS = 1000
const MINUTES = 60 * SECONDS
const HOURS = 60 * MINUTES

const ONE_NEAR = BigInt(10)**BigInt(24);
//------------------------------
//--- connect buttons->code ----
//------------------------------

//all popup "cancel" buttons
qsa('.popup button#cancel').forEach(f=>(f as HTMLButtonElement).onclick= (event)=>{ event.preventDefault(); hideOverlay() })

//connect wallet selection boxes
qs('#near-web-wallet-box').onclick = loginNearWebWallet
qs('#narwallets-wallet-box').onclick = loginNarwallets
//connect Sign-out link
//qs('#sign-out-button').onclick = logoutNearWebWallet

//nav my-account "home"
qs('nav #home').onclick = 
async function(event) {
  event.preventDefault()
  if (wallet.isConnected()) {
    signedInFlow()
  }
  else {
    signedOutFlow();
  }
}

//generic nav handler
function navClickHandler_ConnectFirst(event:Event){
  event.preventDefault()
  if (wallet.isConnected()){
    //show section with same id as the <anchor> link
    showSection( "#"+(event.target as HTMLElement).closest("a")?.id) 
  } 
  else  {
    showSection("#home") 
    sayChoose()
  }
}

qs('nav #unstake').onclick = navClickHandler_ConnectFirst
qs('nav #liquidity').onclick = navClickHandler_ConnectFirst
qs('nav #delayed-unstake').onclick = navClickHandler_ConnectFirst
qs('nav #my-account').onclick = navClickHandler_ConnectFirst

qs('#unstake-from-my-account').onclick = ()=>{showSection("#unstake")}

qs('nav #faq').onclick = ()=>{showSection("#faq")}

function sayChoose(){
  showMessage("Please choose a wallet to connect","Connect first");
}

//button connect
qs('#stake-form-not-connected').onsubmit = 
async function(event) {
  event.preventDefault()
  sayChoose();
}


//button sign-out
qs('#sign-out').onclick = 
async function(event) {
  event.preventDefault()
  wallet.disconnect();
  wallet=disconnectedWallet;
  contract.wallet = disconnectedWallet;
  signedOutFlow();
}

//button stake
qs('form#stake').onsubmit = 
async function(event) {
  event.preventDefault()

  const form = event.target as HTMLFormElement
  // get elements from the form using their id attribute
  const {fieldset,stakeAmount} = form

  // disable the form while the call is made
  fieldset.disabled = true
  showWait("staking...")

  try {
    //get amount
    const amountToStake = toNumber(stakeAmount.value);
    const MIN = yton(contractState.min_deposit_amount)
    if (amountToStake < MIN ) throw Error(`Stake at least ${MIN} NEAR`);

    // make a call to the smart contract
    await contract.deposit_and_stake(amountToStake)

    //clear form
    form.reset()

    //refresh acc info
    await refreshAccountInfo()

    showSuccess("Staked "+toStringDecMin(amountToStake)+" NEAR")

  }
  catch (ex) {
      showErr(ex)
  }

  // re-enable the form, whether the call succeeded or failed
  fieldset.disabled = false

}

/// make same fee calculation as contract (linear curve from max to min on target)
function get_discount_basis_points(liquidity:bigint, sell:bigint):number {
  
  try {

    if (sell > liquidity) {
      //more asked than available => max discount
      return contractState.nslp_max_discount_basis_points
    }

    const target = BigInt(contractState.nslp_target);
    const liq_after = liquidity - sell;
    if (liq_after  >=  target) {
      //still >= target after swap => min discount
      return contractState.nslp_min_discount_basis_points
    }

    let range = BigInt(contractState.nslp_max_discount_basis_points - contractState.nslp_min_discount_basis_points);
    //here 0<after<target, so 0<proportion<range
    const proportion:bigint = range * liq_after / target;
    return contractState.nslp_max_discount_basis_points - Number(proportion);

  }
  catch(ex){
    console.error(ex);
    return contractState.nslp_current_discount_basis_points;
  }

}

//while the user types in the unstake input-field
qs('input#unstakeAmount').oninput = 
function(event:Event) {
  let value = (event.target as HTMLInputElement).value ;
  let userSell = toNumber(value);
  let fee_bp;
  let extraMsg = "";
  if (isNaN(userSell) || userSell<=0 ) {
    fee_bp = contractState.nslp_current_discount_basis_points;
  }
  else {
    const liquidity = BigInt(contractState.nslp_liquidity)
    const sell = BigInt(ntoy(userSell))
    fee_bp = get_discount_basis_points( liquidity , sell);
    if (liquidity<sell) extraMsg=" - Not enough liquidity"
  }
  qs("section#unstake #liquidity-unstake-fee").innerText = (fee_bp/100).toString() + "%" + extraMsg ;
}

//button stake max 
qs('section#home-connected #max').onclick = stakeMaxClick;
async function stakeMaxClick(event:MouseEvent){
  try {
    event.preventDefault()
    let input:HTMLInputElement|null|undefined = (event.target as HTMLElement).closest(".input-group")?.querySelector("input")
    if (input){
      let maxStake = BigInt(await wallet.getAccountBalance()) - ONE_NEAR/BigInt(100) //subtract one cent .- leave something for fee & storage
      //let maxStakeNear = Math.trunc(yton(maxStake.toString()))
      if (maxStake<0) maxStake=BigInt(0);
      input.value = toStringDecMin(yton(maxStake.toString()))
    }
  }
  catch(ex){
    showErr(ex)
  }
}

//button unstake max
qs('form#unstake #max').onclick = 
async function(event) {
  try {
    event.preventDefault()
    qsi("#unstakeAmount").value = toStringDecMin(yton(metaAccountInfo.stnear))
  }
  catch(ex){
    showErr(ex)
  }
} 

//unstake form
qs('form#unstake').onsubmit = 
async function(event) {
  event.preventDefault()

  // get elements from the form using their id attribute
  const form = event.target as HTMLFormElement
  const {fieldset,unstakeAmount} = form 

  // disable the form while the call is made
  fieldset.disabled = true
  showWait("unstaking...")

  try {
    //get amount
    const amountToUnstake = toNumber(unstakeAmount.value);

    checkMinUnstake(amountToUnstake)

    const liquidity = BigInt(contractState.nslp_liquidity)
    const sellAmount = BigInt(ntoy(amountToUnstake))
    if (sellAmount>liquidity) throw Error(`There's not enough liquidity. Max is ${toStringDecMin(yton(contractState.nslp_liquidity))} NEAR. You can use delayed-unstake for large amounts`);
    const fee_bp = get_discount_basis_points( liquidity , sellAmount);

    const expectedMin = amountToUnstake * (10000-fee_bp)/10000 * 99/100 //auto slippage 1%

    // make a call to the smart contract
    const result = await contract.liquid_unstake(amountToUnstake, expectedMin)

    //clear form
    form.reset()

    //refresh acc info
    await refreshAccountInfo()

    showUnstakeResult(result)

  }
  catch (ex) {
      showErr(ex)
  }
  // re-enable the form, whether the call succeeded or failed
  fieldset.disabled = false
}

function showUnstakeResult(result:LiquidUnstakeResult){
  showSuccess(
    `<div class="stat-line"> <dt>NEAR received</dt><dd>${toStringDec(yton(result.near))}</dd> </div>`+
    `<div class="stat-line"> <dt>$META received</dt><dd>${toStringDec(yton(result.meta))}</dd> </div>`+
    `<div class="stat-line"> <dt>Fee</dt><dd>${toStringDec(yton(result.fee))}</dd> </div>`
    ,"Liquid Unstake"
    )
}

function showRemoveLiquidityResult(result:RemoveLiquidityResult){
  showSuccess(
    `<div class="stat-line"> <dt>NEAR received</dt><dd>${toStringDec(yton(result.near))}</dd> </div>`+
    `<div class="stat-line"> <dt>cheddar received</dt><dd>${toStringDec(yton(result.st_near))}</dd> </div>`
    ,"Remove Liquidity"
    )
}


//add liquidity button
qs('button#add-liquidity').onclick= 
async function(event) {
  event.preventDefault()
  showPopup("#add-liquidity.popup")
}
//add liquidity popup-form
qs('form#add-liquidity').onsubmit = 
async function(event) {
  event.preventDefault()

  const form = event.target as HTMLFormElement
  // get elements from the form using their id attribute
  const {fieldset,amountElem} = form

  // disable the form while the call is made
  fieldset.disabled = true
  showWait("adding liquidity...")

  try {
    //get amount
    const amount = toNumber(amountElem.value);
    const MIN_ADD_LIQ = 2*yton(contractState.min_deposit_amount)
    if (amount < MIN_ADD_LIQ) throw Error(`add at least ${MIN_ADD_LIQ} NEAR`);

    // make a call to the smart contract
    await contract.nslp_add_liquidity(amount)
    
    //clear form
    form.reset()

    //refresh acc info
    await refreshAccountInfo()

    showLiquidityOwned()
  
  }
  catch (ex) {
      showErr(ex)
  }
  // re-enable the form, whether the call succeeded or failed
  fieldset.disabled = false
}

function showLiquidityOwned(){
  showSuccess(`You own ${metaAccountInfo.nslp_share_bp==0? "<0.01": toStringDecMin(metaAccountInfo.nslp_share_bp/100)}% of the Liquidity Pool`,"Add liquidity")    
}

//remove liquidity button
qs('button#remove-liquidity').onclick= 
async function(event) {
  event.preventDefault()
  showPopup("#remove-liquidity.popup")
}
//remove liquidity max button
qs('form#remove-liquidity #max').onclick = 
async function(event) {
  try {
    event.preventDefault()
    qsi("form#remove-liquidity #amountElem").value = toStringDecMin(yton(metaAccountInfo.nslp_share_value))
  }
  catch(ex){
    showErr(ex)
  }
} 
//remove liquidity popup-form
qs('form#remove-liquidity').onsubmit = 
async function(event) {
  event.preventDefault()

  const form = event.target as HTMLFormElement
  // get elements from the form using their id attribute
  const {fieldset,amountElem} = form

  // disable the form while the call is made
  fieldset.disabled = true
  showWait("removing liquidity...")

  try {
    //get amount
    const amount = toNumber(amountElem.value);
    if (amount<=0) throw Error("amount should be greater than zero");

    // make a call to the smart contract
    let result = await contract.nslp_remove_liquidity(amount)
    
    //clear form
    form.reset()

    //refresh acc info
    await refreshAccountInfo()

    showRemoveLiquidityResult(result)
  
  }
  catch (ex) {
      showErr(ex)
  }
  // re-enable the form, whether the call succeeded or failed
  fieldset.disabled = false
}

//------ DELAYED UNSTAKE
//delayed unstake max button
qs('form#delayed-unstake #max').onclick = 
async function(event) {
  try {
    event.preventDefault()
    qsi("form#delayed-unstake #amountElem").value = toStringDecMin(yton(metaAccountInfo.stnear))
  }
  catch(ex){
    showErr(ex)
  }
} 

//compute epoch info
let epochCached: EpochInfo;
let endOfEpochCached = new Date();
let epochDurationMs = 12*HOURS;
async function endOfEpoch():Promise<Date> {
  if (new Date() >= endOfEpochCached && wallet.isConnected()){
    try {
      epochCached = await computeCurrentEpoch(wallet);
      endOfEpochCached = new Date(epochCached.ends_dtm);
      epochDurationMs = epochCached.duration_ms;
    }
    catch(ex){
      showErr(ex);
      return new Date(new Date().getTime()-12*HOURS);
    }
  }
  return endOfEpochCached;
}

function checkMinUnstake(amountToUnstake:number){
  const MIN_UNSTAKE_NEAR = 1
  let accountcheddar = yton(metaAccountInfo.stnear)
  if (accountcheddar<=MIN_UNSTAKE_NEAR) {
    //the user owns a ver low amount => unstake all
    if (amountToUnstake+0.0000001<accountcheddar) throw Error(`unstake at least ${accountcheddar} NEAR`);
  }
  else {
    if (amountToUnstake<MIN_UNSTAKE_NEAR) throw Error(`unstake at least ${MIN_UNSTAKE_NEAR} NEAR`);
  }
}

//delayed unstake warning -> withdraw now
qs('#delayed-unstake-warning #withdraw-now').onclick= withdrawUnstakedClickHandler;

//delayed unstake initial form
qs('form#delayed-unstake').onsubmit = 
async function(event) {
  event.preventDefault()

  //do not start a new waiting period before withdrawing the last-one!
  if (metaAccountInfo.unstaked!="0" && metaAccountInfo.can_withdraw) {
    showPopup("#delayed-unstake-warning");
    return;
  }

  const form = event.target as HTMLFormElement
  // get elements from the form using their id attribute
  const {fieldset,amountElem} = event.target as HTMLFormElement

  // disable the form while the call is made
  fieldset.disabled = true

  try {

    //get amount
    const amount = toNumber(amountElem.value)
    checkMinUnstake(amount)

    qs("#delayed-unstake-confirm.popup #amount").innerText=toStringDec(amount);

    let computedMsg:string;
    try {
      showWait("Computing epoch info","Delayed unstake")
      //compute delay according to contract state
      const wait_epochs = await contract.compute_current_unstaking_delay(amount);
      //compute from current epoch
      const epochEnds = await endOfEpoch(); //when the current epoch ends
      const ms_to_end_of_epoch = epochEnds.getTime() - new Date().getTime()
      const extra_time = (wait_epochs-1) * epochDurationMs;
      computedMsg = `Funds will be available in approximately <b>${Math.round((ms_to_end_of_epoch+extra_time)/HOURS+2)} hours.</b> You will <b>not</b> receive rewards during that period.`;
    }
    catch(ex){
      computedMsg=ex.message;
    }
    finally {
      hideWaitKeepOverlay()
    }

    qs("#delayed-unstake-confirm.popup .header-note").innerHTML=computedMsg;
    
    //clear form
    form.reset()

    showPopup("#delayed-unstake-confirm.popup")

  }
  catch (ex) {
      showErr(ex)
  }
  // re-enable the form, whether the call succeeded or failed
  fieldset.disabled = false
}

//delayed unstake popup-form
qs('form#delayed-unstake-confirm').onsubmit = 
async function(event) {
  event.preventDefault()

  showWait("starting delayed unstake...")

  try {
    //get amount from div on screen 
    const amount = toNumber(qs("#delayed-unstake-confirm.popup #amount").innerText);
    if (amount<=0) throw Error("amount should be greater than zero");

    // make a call to the smart contract
    let result = await contract.unstake(amount)
    
    //refresh acc info
    await refreshAccountInfo()

    showSuccess("Delayed Unstake process started")
  
  }
  catch (ex) {
    showErr(ex)
  }
}

//delayed unstake withdraw button
qs('button#delayed-withdraw-unstaked').onclick = withdrawUnstakedClickHandler;

async function withdrawUnstakedClickHandler(event:MouseEvent) {
  event.preventDefault()

  showWait("withdrawing unstaked...")

  try {
    // make a call to the smart contract
    let result = await contract.withdraw_unstaked()
    
    //refresh acc info
    await refreshAccountInfo()

    showSuccess("unstaked transferred to you NEAR account")
  
  }
  catch (ex) {
      showErr(ex)
  }
} 

//--------------------------------------
// AutoRefresh
async function autoRefresh(){
  if (wallet && wallet.isConnected()){
    try {
      await refreshAccountInfo()
    }
    catch(ex){
      console.log("auto-refresh: "+ex.message)
    }
  }
  setTimeout(autoRefresh,10*MINUTES)
  console.log("auto-refresh")
}

//--------------------------------------
function showSection(selector:string){
  //hide all sections
  qsa("main section").forEach(hide);
  //show section
  const section = qs("main").querySelector(selector)
  if (section) {
    show(section)
    selectNav(selector);
  }
}
function selectNav(selector:string){
  //nav
  const allNav=qsa("nav a");
  allNav.forEach( e=> (e as HTMLElement).classList.remove("selected"))
  qs("nav").querySelector(selector)?.classList.add("selected")
}

//after connecting, preserve the amount the user typed on home screen
function takeUserAmountFromHome():string{
  let result="";
  try {
    //move amount typed while not-connected
    const notConnectedStakeInput = qsi("#stake-form-not-connected input.near")
    result=notConnectedStakeInput.value;
    //check also local storage
    if (!result) result = localStorage.getItem("amount")||""
    if (result) {
      qsi("#stake input.near").value = result
      notConnectedStakeInput.value="" //clear.- move only once
      localStorage.removeItem("amount")
    }
  } 
  catch(ex) {
    //ignore
  }
  return result;
}

// Display the signed-out-flow container
async function signedOutFlow() {
  showSection("#home")
  await refreshAccountInfo();
}

// Displaying the signed in flow container and fill in account-specific data
async function signedInFlow() {
  showSection("#home-connected")
  selectNav("#home")
  takeUserAmountFromHome()
  await refreshAccountInfo()

}

// Initialize contract & set global variables
async function initNearWebWalletConnection() {
  // Initialize connection to the NEAR testnet
  const near = await connect(Object.assign({ deps: { keyStore: new keyStores.BrowserLocalStorageKeyStore() } }, nearConfig))

  // Initializing Wallet based Account. It can work with NEAR testnet wallet that
  // is hosted at https://wallet.testnet.near.org
  nearWebWalletConnection = new WalletConnection(near,null)

  // // Initializing our contract APIs by contract name and configuration
  // contract = (await new Contract(walletConnection.account(), nearConfig.contractName, {
  //   // View methods are read only. They don't modify the state, but usually return some value.
  //   viewMethods: ['getGreeting'],
  //   // Change methods can modify the state. But you don't receive the returned value when called.
  //   changeMethods: ['setGreeting'],
  // })
  // ) as unknown as GreetingContract;
}

function logoutNearWebWallet() {
  nearWebWalletConnection.signOut()
  wallet = disconnectedWallet
  contract.disconnect();
  // reload page
  window.location.replace(window.location.origin + window.location.pathname)
}

function loginNearWebWallet() {
  // Allow the current app to make calls to the specified contract on the user's behalf.
  // This works by creating a new access key for the user's account and storing
  // the private key in localStorage.
  //save what the user typed before navigating out
  localStorage.setItem("amount",qsi("#stake-form-not-connected input.near").value)
  nearWebWalletConnection.requestSignIn(nearConfig.contractName)
}

function loginNarwallets() {
  //login is initiated from the chrome-extension
  //show step-by-step instructions
  window.open("http://www.narwallets.com/help/connect-to-web-app")
}

async function refreshAccountInfo(){
  try{
    let accName = wallet.getAccountId();
    if (accName.length>22) accName=accName.slice(0,10)+".."+accName.slice(-10);
    qs(".user-info #account-id").innerText = accName;
    //show top-right-balance only if connected wallet
    show(qs("#top-right-balance"), wallet.isConnected())

    //update shown wallet balance
    qsaInnerText("#wallet-available", toStringDec(yton(await wallet.getAccountBalance())));

    //update account & contract stats
    if (wallet.isConnected()){
      metaAccountInfo = await contract.get_account_info()
      contractState = await contract.get_contract_state()
    }
    qsaInnerText("#cheddar-balance", toStringDec(yton(metaAccountInfo.stnear)) )
    qsaInnerText("#meta-balance", toStringDec(yton(metaAccountInfo.meta)) )
    qs("#trip-rewards").innerText = toStringDec(yton(metaAccountInfo.trip_rewards))
    qs("#trip-start").innerText = new Date(Number(metaAccountInfo.trip_start)).toLocaleString()
    qsaInnerText("#your-share-value", toStringDec(yton(metaAccountInfo.nslp_share_value)))
    qsaInnerText("#your-share", toStringDecMin(metaAccountInfo.nslp_share_bp/100))
    
    //contract state
    qsaInnerText("#historic-rewards", toStringDec(yton(contractState.accumulated_staked_rewards)))
    qsaInnerText("#total-cheddar-tokens", toStringDec(yton(contractState.total_for_staking)))
    qsaInnerText("#liquidity-balance", toStringDec(yton(contractState.nslp_liquidity)))
    qsaInnerText("#liquidity-cheddar-balance", toStringDec(yton(contractState.nslp_stnear_balance)))
    qsaInnerText("#target-liquidity", toStringDec(yton(contractState.nslp_target)))
    qsaInnerText("#liquidity-unstake-fee", (contractState.nslp_current_discount_basis_points/100).toString()+"%")
    qsaInnerText("#number-pools", contractState.staking_pools_count?.toString());

    //delayed-unstake
    qsaInnerText("#delayed-unstake-amount", toStringDec(yton(metaAccountInfo.unstaked)))
    const hasUnstaked = (metaAccountInfo.unstaked!="0")
    show(qs("#delayed-unstake-info-group"), hasUnstaked )
    if (hasUnstaked) {
      qsi("button#delayed-withdraw-unstaked").disabled = !metaAccountInfo.can_withdraw;
      if (metaAccountInfo.can_withdraw) {
        qsaInnerText("#delayed-unstake-hours", "0")
        hide(qs("#delayed-unstake-when-line"))
      }
      else  {
        const epochEnds = await endOfEpoch(); //when the current epoch ends
        const ms_to_end_of_epoch = Math.max(0,epochEnds.getTime() - new Date().getTime())
        const extra_time = metaAccountInfo.unstake_full_epochs_wait_left>0? (metaAccountInfo.unstake_full_epochs_wait_left-1) * epochDurationMs : 0;
        qsaInnerText("#delayed-unstake-hours", Math.trunc((ms_to_end_of_epoch+extra_time)/HOURS+2).toString())
        qsaInnerText("#delayed-unstake-when", new Date(epochEnds.getTime()+extra_time+HOURS).toLocaleString())
        show(qs("#delayed-unstake-when-line"))
      }
    }
  }
  catch(ex){
    showErr(ex)
  }
}

/// when the user chooses "connect to web-page" in the narwallets-chrome-extension
function narwalletConnected(ev:CustomEvent){
  wallet = narwallets;
  contract.wallet = narwallets; //set the contract to use narwallets
  signedInFlow()
}

/// when the user chooses "disconnect from web-page" in the narwallets-chrome-extension
function narwalletDisconnected(ev:CustomEvent){
  // const div = d.byId("connection-info")
  // div.innerText = "Not connected";
  // div.classList.remove("connected")
  // d.showSuccess("wallet disconnected")
  // InitialPage.show()
  wallet = disconnectedWallet;
  contract.wallet = disconnectedWallet;
  signedOutFlow()
}

//`nearInitPromise` gets called on page load
// window.nearInitPromise = initContract()
  // .then(() => {
    // if (walletConnection.isSignedIn()) signedInFlow()
    // else signedOutFlow()
  // })
  // .catch(console.error)

window.onload = async function () {
  try {

    let env="testnet" //default
    //change to mainnet if ure contains /DApp/mainnet/
    //get from url: DApp/testnet/ or DApp/mainnet/
    const parts = window.location.pathname.split("/")
    const i = parts.indexOf("DApp")
    if (i>=0){ env=parts[i+1] }
    if (env!=nearConfig.networkId) nearConfig = getConfig(env);

    //init contract proxy
    contract = new MetaPool(nearConfig.contractName);
  
    //init narwallets listeners
    narwallets.setNetwork(nearConfig.networkId); //tell the wallet which network we want to operate on
    addNarwalletsListeners(narwalletConnected,narwalletDisconnected) //listen to narwallets events

    //set-up auto-refresh loop
    autoRefresh()

    //check if signed-in with NEAR Web Wallet
    await initNearWebWalletConnection() 

    if (nearWebWalletConnection.isSignedIn()) {
      //already signed-in with NEAR Web Wallet
      //make the contract use NEAR Web Wallet
      wallet = new NearWebWallet(nearWebWalletConnection);
      contract.wallet = wallet;

      await signedInFlow()

      //check if we're re-spawning after a wallet-redirect
      //show transaction result depending on method called
      const {err,data,method} = await checkRedirectSearchParams(nearWebWalletConnection, nearConfig.explorerUrl||"explorer");
      if (err){
        showError(err,"Transaction - " + method||"");
      }
      else if (method=="deposit_and_stake"){
            showSuccess("Deposit Successful")
      }
      else if (data){
        switch(method){
          case "liquid_unstake":{
            showSection("#unstake")
            showUnstakeResult(data)    
            break;
          }
          case "nslp_add_liquidity":{
            showSection("#liquidity")
            showLiquidityOwned();
            break;
          }
          case "nslp_remove_liquidity":{
            showSection("#liquidity")
            showRemoveLiquidityResult(data);
            break;
          }
          case "unstake":{
            showSection("#delayed-unstake")
            showSuccess("Delayed Unstake process started")
            break;
          }
          default:
            showSuccess(data.toString(),"Transaction Result")
          }
      }

    }
    else {
      //not signed-in 
      await signedOutFlow() //show home-not-connected -> select wallet page
    }
  }
  catch(ex) {
    showErr(ex)
  }
}
