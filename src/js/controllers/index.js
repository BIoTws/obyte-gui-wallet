'use strict';

var async = require('async');
var mutex = require('byteballcore/mutex.js');
var device = require('byteballcore/device.js');
var bbWallet = require('byteballcore/wallet.js');
var lightWallet = require('byteballcore/light_wallet.js');
var walletDefinedByKeys = require('byteballcore/wallet_defined_by_keys.js');
var eventBus = require('byteballcore/event_bus.js');
var objectHash = require('byteballcore/object_hash.js');
var ecdsaSig = require('byteballcore/signature.js');
var breadcrumbs = require('byteballcore/breadcrumbs.js');
var Bitcore = require('bitcore-lib');

angular.module('copayApp.controllers').controller('indexController', function($rootScope, $scope, $log, $filter, $timeout, lodash, go, profileService, configService, isCordova, storageService, addressService, gettext, gettextCatalog, amMoment, nodeWebkit, addonManager, txFormatService, uxLanguage, $state, isMobile, addressbookService, notification, animationService, $modal, bwcService) {
  breadcrumbs.add('index.js');
  var self = this;
  self.isCordova = isCordova;
  self.isSafari = isMobile.Safari();
  self.onGoingProcess = {};
  self.historyShowLimit = 10;
  self.updatingTxHistory = {};
  self.bSwipeSuspended = false;
    /*
    console.log("process", process.env);
    var os = require('os');
    console.log("os", os);
    //console.log("os homedir="+os.homedir());
    console.log("release="+os.release());
    console.log("hostname="+os.hostname());
    //console.log(os.userInfo());
    */

    
    function updatePublicKeyRing(walletClient, onDone){
        walletDefinedByKeys.readCosigners(walletClient.credentials.walletId, function(arrCosigners){
            var arrApprovedDevices = arrCosigners.
                filter(function(cosigner){ return cosigner.approval_date; }).
                map(function(cosigner){ return cosigner.device_address; });
            console.log("approved devices: "+arrApprovedDevices.join(", "));
            walletClient.credentials.addPublicKeyRing(arrApprovedDevices);
            
            // save it to profile
            var credentialsIndex = lodash.findIndex(profileService.profile.credentials, {walletId: walletClient.credentials.walletId});
            if (credentialsIndex < 0)
                throw Error("failed to find our credentials in profile");
            profileService.profile.credentials[credentialsIndex] = JSON.parse(walletClient.export());
            console.log("saving profile: "+JSON.stringify(profileService.profile));
            storageService.storeProfile(profileService.profile, function(){
                if (onDone)
                    onDone();
            });
        });
    }
    
    function sendBugReport(error_message, error_object){
        var conf = require('byteballcore/conf.js');
        var network = require('byteballcore/network.js');
        var bug_sink_url = conf.WS_PROTOCOL + (conf.bug_sink_url || configService.getSync().hub);
        network.findOutboundPeerOrConnect(bug_sink_url, function(err, ws){
            if (err)
                return;
			breadcrumbs.add('bugreport');
			var description = error_object.stack || JSON.stringify(error_object, null, '\t');
			description += "\n\nBreadcrumbs:\n"+breadcrumbs.get().join("\n")+"\n\n";
			description += "UA: "+navigator.userAgent+"\n";
			description += "Program: "+conf.program+' '+conf.program_version+"\n";
            network.sendJustsaying(ws, 'bugreport', {message: error_message, exception: description});
        });
    }
    
    eventBus.on('uncaught_error', function(error_message, error_object) {
		console.log('stack', error_object.stack);
        sendBugReport(error_message, error_object);
        self.showErrorPopup(error_message, function() {
            if (self.isCordova && navigator && navigator.app) // android
                navigator.app.exitApp();
            else if (process.exit) // nwjs
                process.exit();
            // ios doesn't exit
        });
    });
    
    eventBus.on('catching_up_started', function(){
        self.setOngoingProcess('Syncing', true);
    });
    eventBus.on('catching_up_done', function(){
        self.setOngoingProcess('Syncing', false);
    });
    eventBus.on('refresh_light_started', function(){
		console.log('refresh_light_started');
        self.setOngoingProcess('Syncing', true);
    });
    eventBus.on('refresh_light_done', function(){
		console.log('refresh_light_done');
        self.setOngoingProcess('Syncing', false);
    });
    
    eventBus.on("confirm_on_other_devices", function(){
        $rootScope.$emit('Local/ShowAlert', "Transaction created.\nPlease approve it on the other devices.", 'fi-key', function(){
            go.walletHome();
        });
    });

    eventBus.on("refused_to_sign", function(device_address){
        device.readCorrespondent(device_address, function(correspondent){
            notification.success(gettextCatalog.getString('Refused'), correspondent.name + " refused to sign the transaction");
        });
    });

    /*
    eventBus.on("transaction_sent", function(){
        self.updateAll();
        self.updateTxHistory();
    });*/

    eventBus.on("new_my_transaction", function(){
        self.updateAll();
        self.updateTxHistory();
    });

    eventBus.on("my_transaction_became_stable", function(){
        self.updateAll();
        self.updateTxHistory();
    });

    eventBus.on("maybe_new_transactions", function(){
        self.updateAll();
        self.updateTxHistory();
    });

    eventBus.on("wallet_approved", function(walletId, device_address){
        console.log("wallet_approved "+walletId+" by "+device_address);
        var client = profileService.walletClients[walletId];
        if (!client) // already deleted (maybe declined by another device) or not present yet
            return;
        var walletName = client.credentials.walletName;
        updatePublicKeyRing(client);
        device.readCorrespondent(device_address, function(correspondent){
            notification.success(gettextCatalog.getString('Success'), "Wallet "+walletName+" approved by "+correspondent.name);
        });
    });

    eventBus.on("wallet_declined", function(walletId, device_address){
        var client = profileService.walletClients[walletId];
        if (!client) // already deleted (maybe declined by another device)
            return;
        var walletName = client.credentials.walletName;
        device.readCorrespondent(device_address, function(correspondent){
            notification.info(gettextCatalog.getString('Declined'), "Wallet "+walletName+" declined by "+correspondent.name);
        });
        // focus the wallet before deleting it
        profileService.setAndStoreFocus(walletId, function(){
            profileService.deleteWalletFC({}, function(err) {
                if (err) {
                    console.log(err);
                }
                else {
                    // may change focus to a wallet that is different from the one that was focused when the event arrived
                    var newFocusedWalletId = Object.keys(profileService.walletClients)[0];
                    if (newFocusedWalletId)
                        profileService.setAndStoreFocus(newFocusedWalletId, function(){});
                    else
                        go.walletHome(); 
                }
            });
        });
    });

    eventBus.on("wallet_completed", function(walletId){
        console.log("wallet_completed "+walletId);
        var client = profileService.walletClients[walletId];
        if (!client) // impossible
            return;
        var walletName = client.credentials.walletName;
        updatePublicKeyRing(client, function(){
            if (!client.isComplete())
                throw Error("not complete");
            notification.success(gettextCatalog.getString('Success'), "Wallet "+walletName+" is ready");
            $rootScope.$emit('Local/WalletCompleted');
        });
    });
    
    // in arrOtherCosigners, 'other' is relative to the initiator
    eventBus.on("create_new_wallet", function(walletId, arrWalletDefinitionTemplate, arrDeviceAddresses, walletName, arrOtherCosigners){
        device.readCorrespondentsByDeviceAddresses(arrDeviceAddresses, function(arrCorrespondentInfos){
            // my own address is not included in arrCorrespondentInfos because I'm not my correspondent
            var arrNames = arrCorrespondentInfos.map(function(correspondent){ return correspondent.name; });
            var name_list = arrNames.join(", ");
            var question = gettextCatalog.getString('Create new wallet '+walletName+' together with '+name_list+' ?');
            requestApproval(question, {
                ifYes: function(){
                    console.log("===== YES CLICKED")
                    walletDefinedByKeys.readNextAccount(function(account){
                        var walletClient = bwcService.getClient();
                        //walletClient.seedFromExtendedPrivateKey(profileService.profile.xPrivKey, account);
                        walletClient.seedFromMnemonic(profileService.profile.mnemonic, {account: account});
                        walletDefinedByKeys.approveWallet(
                            walletId, walletClient.credentials.xPubKey, account, arrWalletDefinitionTemplate, arrOtherCosigners, 
                            function(){
                                walletClient.credentials.walletId = walletId;
                                walletClient.credentials.network = 'livenet';
                                var n = arrDeviceAddresses.length;
                                var m = arrWalletDefinitionTemplate[1].required || n;
                                walletClient.credentials.addWalletInfo(walletName, m, n);
                                updatePublicKeyRing(walletClient);
                                profileService._addWalletClient(walletClient, {}, function(){
                                    console.log("switched to newly approved wallet "+walletId);
                                });
                            }
                        );
                    });
                },
                ifNo: function(){
                    console.log("===== NO CLICKED")
                    walletDefinedByKeys.cancelWallet(walletId, arrDeviceAddresses, arrOtherCosigners);
                }
            });
        });
    });
    
    // units that were already approved or rejected by user.
    // if there are more than one addresses to sign from, we won't pop up confirmation dialog for each address, instead we'll use the already obtained approval
    var assocChoicesByUnit = {};

    eventBus.on("signing_request", function(objAddress, objUnit, assocPrivatePayloads, from_address, signing_path){
        
        function createAndSendSignature(){
            var coin = "0";
            var path = "m/44'/" + coin + "'/" + objAddress.account + "'/"+objAddress.is_change+"/"+objAddress.address_index;
            console.log("path "+path);
            // focused client might be different from the wallet this signature is for, but it doesn't matter as we have a single key for all wallets
            if (profileService.focusedClient.isPrivKeyEncrypted()){
                console.log("priv key is encrypted, will be back after password request");
                return profileService.insistUnlockFC(null, function(){
                    createAndSendSignature();
                });
            }
            var xPrivKey = new Bitcore.HDPrivateKey.fromString(profileService.profile.xPrivKey);
            var privateKey = xPrivKey.derive(path).privateKey;
            console.log("priv key:", privateKey);
            //var privKeyBuf = privateKey.toBuffer();
            var privKeyBuf = privateKey.bn.toBuffer({size:32}); // https://github.com/bitpay/bitcore-lib/issues/47
            console.log("priv key buf:", privKeyBuf);
            var buf_to_sign = objectHash.getUnitHashToSign(objUnit);
            var signature = ecdsaSig.sign(buf_to_sign, privKeyBuf);
            bbWallet.sendSignature(from_address, buf_to_sign.toString("base64"), signature, signing_path, objAddress.address);
            console.log("sent signature "+signature);
        }
        
        function refuseSignature(){
            var buf_to_sign = objectHash.getUnitHashToSign(objUnit);
            bbWallet.sendSignature(from_address, buf_to_sign.toString("base64"), "[refused]", signing_path, objAddress.address);
            console.log("refused signature");
        }
        
        var unit = objUnit.unit;
        var credentials = lodash.find(profileService.profile.credentials, {walletId: objAddress.wallet});
        mutex.lock(["signing_request-"+unit], function(unlock){
            
            // apply the previously obtained decision. 
            // Unless the priv key is encrypted in which case the password request would have appeared from nowhere
            if (assocChoicesByUnit[unit] && !profileService.focusedClient.isPrivKeyEncrypted()){
                if (assocChoicesByUnit[unit] === "approve")
                    createAndSendSignature();
                else if (assocChoicesByUnit[unit] === "refuse")
                    refuseSignature();
                return unlock();
            }
            
            walletDefinedByKeys.readChangeAddresses(objAddress.wallet, function(arrChangeAddresses){
                var arrAuthorAddresses = objUnit.authors.map(function(author){ return author.address; });
                arrChangeAddresses = arrChangeAddresses.concat(arrAuthorAddresses);
                var arrPaymentMessages = objUnit.messages.filter(function(objMessage){ return (objMessage.app === "payment"); });
                if (arrPaymentMessages.length === 0)
                    throw Error("no payment message found");
                var assocAmountByAssetAndAddress = {};
                // exclude outputs paying to my change addresses
                async.eachSeries(
                    arrPaymentMessages,
                    function(objMessage, cb){
                        var payload = objMessage.payload;
                        if (!payload)
                            payload = assocPrivatePayloads[objMessage.payload_hash];
                        if (!payload)
                            throw Error("no inline payload and no private payload either, message="+JSON.stringify(objMessage));
                        var asset = payload.asset || "base";
						if (!payload.outputs)
                            throw Error("no outputs");
                        if (!assocAmountByAssetAndAddress[asset])
                            assocAmountByAssetAndAddress[asset] = {};
						payload.outputs.forEach(function(output){
							if (arrChangeAddresses.indexOf(output.address) === -1){
								if (!assocAmountByAssetAndAddress[asset][output.address])
									assocAmountByAssetAndAddress[asset][output.address] = 0;
								assocAmountByAssetAndAddress[asset][output.address] += output.amount;
							}
						});
						cb();
                    },
                    function(){
                        var arrDestinations = [];
                        for (var asset in assocAmountByAssetAndAddress){
							var formatted_asset = isCordova ? asset : ("<span class='small'>"+asset+'</span><br/>');
                            var currency = (asset !== "base") ? ("of asset "+formatted_asset) : "bytes";
                            for (var address in assocAmountByAssetAndAddress[asset])
                                arrDestinations.push(assocAmountByAssetAndAddress[asset][address] + " " + currency + " to " + address);
                        }
                        var dest = (arrDestinations.length > 0) ? arrDestinations.join(", ") : "to myself";
                        var question = gettextCatalog.getString('Sign transaction spending '+dest+' from wallet '+credentials.walletName+'?');
                        requestApproval(question, {
                            ifYes: function(){
                                createAndSendSignature();
                                assocChoicesByUnit[unit] = "approve";
                                unlock();
                            },
                            ifNo: function(){
                                // do nothing
                                console.log("===== NO CLICKED");
                                refuseSignature();
                                assocChoicesByUnit[unit] = "refuse";
                                unlock();
                            }
                        });
                    }
                ); // eachSeries
            });
        });
    });

    
    var accept_msg = gettextCatalog.getString('Yes');
    var cancel_msg = gettextCatalog.getString('No');
    var confirm_msg = gettextCatalog.getString('Confirm');

    var _modalRequestApproval = function(question, callbacks) {
      var ModalInstanceCtrl = function($scope, $modalInstance, $sce, gettext) {
        $scope.title = $sce.trustAsHtml(question);
        $scope.yes_icon = 'fi-check';
        $scope.yes_button_class = 'primary';
        $scope.cancel_button_class = 'warning';
        $scope.cancel_label = 'No';
        $scope.loading = false;

        $scope.ok = function() {
          $scope.loading = true;
          $modalInstance.close(accept_msg);
        };
        $scope.cancel = function() {
          $modalInstance.dismiss(cancel_msg);
        };
      };

      var modalInstance = $modal.open({
        templateUrl: 'views/modals/confirmation.html',
        windowClass: animationService.modalAnimated.slideUp,
        controller: ModalInstanceCtrl
      });

      modalInstance.result.finally(function() {
        var m = angular.element(document.getElementsByClassName('reveal-modal'));
        m.addClass(animationService.modalAnimated.slideOutDown);
      });

      modalInstance.result.then(callbacks.ifYes, callbacks.ifNo);
    };

    var requestApproval = function(question, callbacks) {
      if (isCordova) {
        navigator.notification.confirm(
          question,
          function(buttonIndex) {
            if (buttonIndex == 1)
                callbacks.ifYes();
            else
                callbacks.ifNo();
          },
          confirm_msg, [accept_msg, cancel_msg]
        );
      } else {
        _modalRequestApproval(question, callbacks);
      }
    };
    
    
    
  self.goHome = function() {
    go.walletHome();
  };

  self.menu = [{
    'title': gettext('Home'),
    'icon': 'icon-home',
    'link': 'walletHome'
  }, {
    'title': gettext('Receive'),
    'icon': 'icon-receive2',
    'link': 'receive'
  }, {
    'title': gettext('Send'),
    'icon': 'icon-paperplane',
    'link': 'send'
  }, {
    'title': gettext('History'),
    'icon': 'icon-history',
    'link': 'history'
  }];

  self.addonViews = addonManager.addonViews();
  self.menu = self.menu.concat(addonManager.addonMenuItems());
  self.menuItemSize = self.menu.length > 5 ? 2 : 3;
  self.txTemplateUrl = addonManager.txTemplateUrl() || 'views/includes/transaction.html';

  self.tab = 'walletHome';


  self.setOngoingProcess = function(processName, isOn) {
    $log.debug('onGoingProcess', processName, isOn);
    self[processName] = isOn;
    self.onGoingProcess[processName] = isOn;

    var name;
    self.anyOnGoingProcess = lodash.any(self.onGoingProcess, function(isOn, processName) {
      if (isOn)
        name = name || processName;
      return isOn;
    });
    // The first one
    self.onGoingProcessName = name;
    $timeout(function() {
      $rootScope.$apply();
    });
  };

  self.setFocusedWallet = function() {
    var fc = profileService.focusedClient;
    if (!fc) return;

    // Clean status
    self.totalBalanceBytes = null;
    self.lockedBalanceBytes = null;
    self.availableBalanceBytes = null;
    self.pendingAmount = null;
    self.spendUnconfirmed = null;

    self.totalBalanceStr = null;
    self.availableBalanceStr = null;
    self.lockedBalanceStr = null;

    self.arrBalances = [];
    self.assetIndex = 0;

    self.txHistory = [];
    self.completeHistory = [];
    self.txProgress = 0;
    self.historyShowShowAll = false;
    self.balanceByAddress = null;
    self.pendingTxProposalsCountForUs = null;
    self.setSpendUnconfirmed();

    $timeout(function() {
        //$rootScope.$apply();
        self.hasProfile = true;
        self.noFocusedWallet = false;
        self.onGoingProcess = {};

        // Credentials Shortcuts
        self.m = fc.credentials.m;
        self.n = fc.credentials.n;
        self.network = fc.credentials.network;
        self.requiresMultipleSignatures = fc.credentials.m > 1;
        self.isShared = fc.credentials.n > 1;
        self.walletName = fc.credentials.walletName;
        self.walletId = fc.credentials.walletId;
        self.isComplete = fc.isComplete();
        self.canSign = fc.canSign();
        self.isPrivKeyExternal = fc.isPrivKeyExternal();
        self.isPrivKeyEncrypted = fc.isPrivKeyEncrypted();
        self.externalSource = fc.getPrivKeyExternalSourceName();
        self.account = fc.credentials.account;

        self.txps = [];
        self.copayers = [];
        self.updateColor();
        self.updateAlias();
        self.setAddressbook();

        console.log("reading cosigners");
        walletDefinedByKeys.readCosigners(self.walletId, function(arrCosignerInfos){
            self.copayers = arrCosignerInfos;
            $rootScope.$digest();
        });

        if (fc.isPrivKeyExternal()) {
            self.needsBackup = false;
            self.openWallet();
        } else {
            storageService.getBackupFlag('all', function(err, val) {
              self.needsBackup = self.network == 'testnet' ? false : !val;
              self.openWallet();
            });
        }
    });
  };


  self.setTab = function(tab, reset, tries, switchState) {
    console.log("setTab", tab, reset, tries, switchState);
    tries = tries || 0;

    // check if the whole menu item passed
    if (typeof tab == 'object') {
      if (tab.open) {
        if (tab.link) {
          self.tab = tab.link;
        }
        tab.open();
        return;
      } else {
        return self.setTab(tab.link, reset, tries, switchState);
      }
    }
    console.log("current tab "+self.tab+", requested to set tab "+tab+", reset="+reset);
    if (self.tab === tab && !reset)
      return;

    if (!document.getElementById('menu-' + tab) && ++tries < 5) {
        console.log("will retry setTab later:", tab, reset, tries, switchState);
        return $timeout(function() {
            self.setTab(tab, reset, tries, switchState);
        }, 300);
    }

    if (!self.tab || !$state.is('walletHome'))
      self.tab = 'walletHome';

    var changeTab = function() {
      if (document.getElementById(self.tab)) {
        document.getElementById(self.tab).className = 'tab-out tab-view ' + self.tab;
        var old = document.getElementById('menu-' + self.tab);
        if (old) {
          old.className = '';
        }
      }

      if (document.getElementById(tab)) {
        document.getElementById(tab).className = 'tab-in  tab-view ' + tab;
        var newe = document.getElementById('menu-' + tab);
        if (newe) {
          newe.className = 'active';
        }
      }

      self.tab = tab;
      $rootScope.$emit('Local/TabChanged', tab);
    };

    if (switchState && !$state.is('walletHome')) {
      go.path('walletHome', function() {
        changeTab();
      });
      return;
    }

    changeTab();
  };






  self.updateAll = function(opts) {
    opts = opts || {};

    var fc = profileService.focusedClient;
    if (!fc) 
        return;

    if (!fc.isComplete())
        return;
      
    // reconnect if lost connection
    device.loginToHub();

    $timeout(function() {

        if (!opts.quiet)
            self.setOngoingProcess('updatingStatus', true);

        $log.debug('Updating Status:', fc.credentials.walletName);
        if (!opts.quiet)
            self.setOngoingProcess('updatingStatus', false);


        fc.getBalance(function(err, assocBalances) {
            if (err)
                throw "impossible getBal";
            $log.debug('updateAll Wallet Balance:', assocBalances);
            self.setBalance(assocBalances);
            // Notify external addons or plugins
            $rootScope.$emit('Local/BalanceUpdated', assocBalances);
        });
        
        self.otherWallets = lodash.filter(profileService.getWallets(self.network), function(w) {
            return w.id != self.walletId;
        });


        //$rootScope.$apply();

        if (opts.triggerTxUpdate) {
            $timeout(function() {
                self.updateTxHistory();
            }, 1);
        }
    });
  };

  self.setSpendUnconfirmed = function() {
    self.spendUnconfirmed = configService.getSync().wallet.spendUnconfirmed;
  };


  self.updateBalance = function() {
    var fc = profileService.focusedClient;
    $timeout(function() {
      self.setOngoingProcess('updatingBalance', true);
      $log.debug('Updating Balance');
      fc.getBalance(function(err, assocBalances) {
        self.setOngoingProcess('updatingBalance', false);
        if (err)
            throw "impossible error from getBalance";
        $log.debug('updateBalance Wallet Balance:', assocBalances);
        self.setBalance(assocBalances);
      });
    });
  };


    
  self.openWallet = function() {
      console.log("index.openWallet called");
    var fc = profileService.focusedClient;
    $timeout(function() {
      //$rootScope.$apply();
      self.setOngoingProcess('openingWallet', true);
      self.updateError = false;
      fc.openWallet(function(err, walletStatus) {
        self.setOngoingProcess('openingWallet', false);
        if (err)
            throw "impossible error from openWallet";
        $log.debug('Wallet Opened');
        self.updateAll(lodash.isObject(walletStatus) ? {
          walletStatus: walletStatus
        } : null);
        //$rootScope.$apply();
      });
    });
  };



  self.processNewTxs = function(txs) {
    var config = configService.getSync().wallet.settings;
    var now = Math.floor(Date.now() / 1000);
    var ret = [];

    lodash.each(txs, function(tx) {
        tx = txFormatService.processTx(tx);

        // no future transactions...
        if (tx.time > now)
            tx.time = now;
        ret.push(tx);
    });

    return ret;
  };

  self.updateAlias = function() {
    var config = configService.getSync();
    config.aliasFor = config.aliasFor || {};
    self.alias = config.aliasFor[self.walletId];
    var fc = profileService.focusedClient;
    fc.alias = self.alias;
  };

  self.updateColor = function() {
    var config = configService.getSync();
    config.colorFor = config.colorFor || {};
    self.backgroundColor = config.colorFor[self.walletId] || '#4A90E2';
    var fc = profileService.focusedClient;
    fc.backgroundColor = self.backgroundColor;
  };

  self.setBalance = function(assocBalances) {
    if (!assocBalances) return;
    var config = configService.getSync().wallet.settings;

    // Selected unit
    self.unitToBytes = config.unitToBytes;
    self.bytesToUnit = 1 / self.unitToBytes;
    self.unitName = config.unitName;

    self.arrBalances = [];
    for (var asset in assocBalances){
        var balanceInfo = assocBalances[asset];
        balanceInfo.asset = asset;
        balanceInfo.total = balanceInfo.stable + balanceInfo.pending;
        if (asset === "base"){
            balanceInfo.totalStr = profileService.formatAmount(balanceInfo.total) + ' ' + self.unitName;
            balanceInfo.stableStr = profileService.formatAmount(balanceInfo.stable) + ' ' + self.unitName;
            balanceInfo.pendingStr = profileService.formatAmount(balanceInfo.pending) + ' ' + self.unitName;
        }
        self.arrBalances.push(balanceInfo);
    }
    self.assetIndex = self.assetIndex || 0;

      /*
    // SAT
    if (self.spendUnconfirmed) {
      self.totalBalanceBytes = balance.totalAmount;
      self.lockedBalanceBytes = balance.lockedAmount || 0;
      self.availableBalanceBytes = balance.availableAmount || 0;
      self.pendingAmount = null;
    } else {
      self.totalBalanceBytes = balance.totalConfirmedAmount;
      self.lockedBalanceBytes = balance.lockedConfirmedAmount || 0;
      self.availableBalanceBytes = balance.availableConfirmedAmount || 0;
      self.pendingAmount = balance.totalAmount - balance.totalConfirmedAmount;
    }

    //STR
    self.totalBalanceStr = profileService.formatAmount(self.totalBalanceBytes) + ' ' + self.unitName;
    self.lockedBalanceStr = profileService.formatAmount(self.lockedBalanceBytes) + ' ' + self.unitName;
    self.availableBalanceStr = profileService.formatAmount(self.availableBalanceBytes) + ' ' + self.unitName;

    if (self.pendingAmount) {
      self.pendingAmountStr = profileService.formatAmount(self.pendingAmount) + ' ' + self.unitName;
    } else {
      self.pendingAmountStr = null;
    }
      */
    $rootScope.$apply();
  };

    
    
  this.csvHistory = function() {

    function saveFile(name, data) {
      var chooser = document.querySelector(name);
      chooser.addEventListener("change", function(evt) {
        var fs = require('fs');
        fs.writeFile(this.value, data, function(err) {
          if (err) {
            $log.debug(err);
          }
        });
      }, false);
      chooser.click();
    }

    function formatDate(date) {
      var dateObj = new Date(date);
      if (!dateObj) {
        $log.debug('Error formating a date');
        return 'DateError'
      }
      if (!dateObj.toJSON()) {
        return '';
      }

      return dateObj.toJSON();
    }

    function formatString(str) {
      if (!str) return '';

      if (str.indexOf('"') !== -1) {
        //replace all
        str = str.replace(new RegExp('"', 'g'), '\'');
      }

      //escaping commas
      str = '\"' + str + '\"';

      return str;
    }

    var step = 6;
    var unique = {};


    if (isCordova) {
      $log.info('CSV generation not available in mobile');
      return;
    }
    var isNode = nodeWebkit.isDefined();
    var fc = profileService.focusedClient;
    var c = fc.credentials;
    if (!fc.isComplete()) return;
    var self = this;
    var allTxs = [];

    $log.debug('Generating CSV from History');
    self.setOngoingProcess('generatingCSV', true);

    $timeout(function() {
      fc.getTxHistory(self.arrBalances[self.assetIndex].asset, function(txs) {
        self.setOngoingProcess('generatingCSV', false);
          $log.debug('Wallet Transaction History:', txs);

          self.bytesToUnit = 1 / self.unitToBytes;
          var data = txs;
          var filename = 'Byteball-' + (self.alias || self.walletName) + '.csv';
          var csvContent = '';

          if (!isNode) csvContent = 'data:text/csv;charset=utf-8,';
          csvContent += 'Date,Destination,Note,Amount,Currency,Spot Value,Total Value,Tax Type,Category\n';

          var _amount, _note;
          var dataString;
          data.forEach(function(it, index) {
            var amount = it.amount;

            if (it.action == 'moved')
              amount = 0;

            _amount = (it.action == 'sent' ? '-' : '') + amount;
            _note = formatString((it.message ? it.message : '') + ' unit: ' + it.unit);

            if (it.action == 'moved')
              _note += ' Moved:' + it.amount

            dataString = formatDate(it.time * 1000) + ',' + formatString(it.addressTo) + ',' + _note + ',' + _amount + ',byte,,,,';
            csvContent += dataString + "\n";

          });

          if (isNode) {
            saveFile('#export_file', csvContent);
          } else {
            var encodedUri = encodeURI(csvContent);
            var link = document.createElement("a");
            link.setAttribute("href", encodedUri);
            link.setAttribute("download", filename);
            link.click();
          }
        $rootScope.$apply();
      });
    });
  };



  self.updateLocalTxHistory = function(client, cb) {
    var walletId = client.credentials.walletId;

    client.getTxHistory(self.arrBalances[self.assetIndex].asset, function onGotTxHistory(txs) {
        var newHistory = self.processNewTxs(txs);
        $log.debug('Tx History synced. Total Txs: ' + newHistory.length);

        if (walletId ==  profileService.focusedClient.credentials.walletId) {
            self.completeHistory = newHistory;
            self.txHistory = newHistory.slice(0, self.historyShowLimit);
            self.historyShowShowAll = newHistory.length >= self.historyShowLimit;
        }

        return cb();
    });
  }
  
  self.showAllHistory = function() {
    self.historyShowShowAll = false;
    self.historyRendering = true;
    $timeout(function() {
      $rootScope.$apply();
      $timeout(function() {
        self.historyRendering = false;
        self.txHistory = self.completeHistory;
      }, 100);
    }, 100);
  };


  self.updateHistory = function() {
    var fc = profileService.focusedClient;
    var walletId = fc.credentials.walletId;

    if (!fc.isComplete() || self.updatingTxHistory[walletId]) return;

    $log.debug('Updating Transaction History');
    self.txHistoryError = false;
    self.updatingTxHistory[walletId] = true;

    $timeout(function onUpdateHistoryTimeout() {
      self.updateLocalTxHistory(fc, function(err) {
        self.updatingTxHistory[walletId] = false;
        if (err)
          self.txHistoryError = true;

        $rootScope.$apply();
      });
    });
  };

  self.updateTxHistory = lodash.debounce(function() {
    self.updateHistory();
  }, 1000);

  self.throttledUpdateHistory = lodash.throttle(function() {
    self.updateHistory();
  }, 5000);
    
//    self.onMouseDown = function(){
//        console.log('== mousedown');
//        self.oldAssetIndex = self.assetIndex;
//    };
    
    self.onClick = function(){
        console.log('== click');
        self.oldAssetIndex = self.assetIndex;
    };
    
    // for light clients only
    self.updateHistoryFromNetwork = lodash.throttle(function(){
        setTimeout(function(){
            if (self.assetIndex !== self.oldAssetIndex) // it was a swipe
                return console.log("== swipe");
            console.log('== updateHistoryFromNetwork');
            lightWallet.refreshLightClientHistory();
        }, 500);
    }, 5000);

  self.showPopup = function(msg, msg_icon, cb) {
    $log.warn('Showing '+msg_icon+' popup:' + msg);
    self.showAlert = {
      msg: msg.toString(),
      msg_icon: msg_icon,
      close: function(err) {
        self.showAlert = null;
        if (cb) return cb(err);
      },
    };
    $timeout(function() {
      $rootScope.$apply();
    });
  };

  self.showErrorPopup = function(msg, cb) {
    $log.warn('Showing err popup:' + msg);
    self.showPopup(msg, 'fi-alert', cb);
  };

  self.recreate = function(cb) {
    var fc = profileService.focusedClient;
    self.setOngoingProcess('recreating', true);
    fc.recreateWallet(function(err) {
      self.setOngoingProcess('recreating', false);

      if (err)
          throw "impossible err from recreateWallet";

      profileService.setWalletClients();
      $timeout(function() {
        $rootScope.$emit('Local/WalletImported', self.walletId);
      }, 100);
    });
  };

  self.openMenu = function() {
    go.swipe(true);
  };

  self.closeMenu = function() {
    go.swipe();
  };
    
    self.swipeRight = function(){
        if (!self.bSwipeSuspended)
            self.openMenu();
        else
            console.log('ignoring swipe');
    };
    
    self.suspendSwipe = function(){
        if (self.arrBalances.length <= 1)
            return;
        self.bSwipeSuspended = true;
        console.log('suspending swipe');
        $timeout(function(){
            self.bSwipeSuspended = false;
            console.log('resuming swipe');
        }, 100);
    };

  self.retryScan = function() {
    var self = this;
    self.startScan(self.walletId);
  }

  self.startScan = function(walletId) {
    $log.debug('Scanning wallet ' + walletId);
    var c = profileService.walletClients[walletId];
    if (!c.isComplete()) return;
      /*
    if (self.walletId == walletId)
      self.setOngoingProcess('scanning', true);

    c.startScan({
      includeCopayerBranches: true,
    }, function(err) {
      if (err && self.walletId == walletId) {
        self.setOngoingProcess('scanning', false);
        self.handleError(err);
        $rootScope.$apply();
      }
    });
      */
  };

  self.setUxLanguage = function() {
    var userLang = uxLanguage.update();
    self.defaultLanguageIsoCode = userLang;
    self.defaultLanguageName = uxLanguage.getName(userLang);
  };



  self.setAddressbook = function(ab) {
    if (ab) {
      self.addressbook = ab;
      return;
    }

    addressbookService.list(function(err, ab) {
      if (err) {
        $log.error('Error getting the addressbook');
        return;
      }
      self.addressbook = ab;
    });
  };
    
    

    function getNumberOfSelectedSigners(){
        var count = 1; // self
        self.copayers.forEach(function(copayer){
            if (copayer.signs)
                count++;
        });
        return count;
    }
    
    self.isEnoughSignersSelected = function(){
        if (self.m === self.n)
            return true;
        return (getNumberOfSelectedSigners() >= self.m);
    };
    
    self.getWallets = function(){
        return profileService.getWallets('livenet');
    };
    

  $rootScope.$on('Local/ClearHistory', function(event) {
    $log.debug('The wallet transaction history has been deleted');
    self.txHistory = self.completeHistory = [];
    self.updateHistory();
  });

  $rootScope.$on('Local/AddressbookUpdated', function(event, ab) {
    self.setAddressbook(ab);
  });

  // UX event handlers
  $rootScope.$on('Local/ColorUpdated', function(event) {
    self.updateColor();
    $timeout(function() {
      $rootScope.$apply();
    });
  });

  $rootScope.$on('Local/AliasUpdated', function(event) {
    self.updateAlias();
    $timeout(function() {
      $rootScope.$apply();
    });
  });

  $rootScope.$on('Local/SpendUnconfirmedUpdated', function(event) {
    self.setSpendUnconfirmed();
    self.updateAll();
  });

  $rootScope.$on('Local/ProfileBound', function() {
  });

  $rootScope.$on('Local/NewFocusedWallet', function() {
    self.setUxLanguage();
  });

  $rootScope.$on('Local/LanguageSettingUpdated', function() {
    self.setUxLanguage();
  });

  $rootScope.$on('Local/UnitSettingUpdated', function(event) {
    self.updateAll();
    self.updateTxHistory();
  });

  $rootScope.$on('Local/NeedFreshHistory', function(event) {
    self.updateHistory();
  });


  $rootScope.$on('Local/WalletCompleted', function(event) {
    self.setFocusedWallet();
    go.walletHome();
  });

  self.debouncedUpdate = lodash.throttle(function() {
    self.updateAll({
      quiet: true
    });
    self.updateTxHistory();
  }, 4000, {
    leading: false,
    trailing: true
  });

  $rootScope.$on('Local/Resume', function(event) {
	$log.debug('### Resume event');
	lightWallet.refreshLightClientHistory();
	//self.debouncedUpdate();
  });

  $rootScope.$on('Local/BackupDone', function(event) {
    self.needsBackup = false;
    $log.debug('Backup done');
    storageService.setBackupFlag('all', function(err) {
        if (err)
            return $log.warn("setBackupFlag failed: "+JSON.stringify(err));
      $log.debug('Backup done stored');
    });
  });

  $rootScope.$on('Local/DeviceError', function(event, err) {
    self.showErrorPopup(err, function() {
      if (self.isCordova && navigator && navigator.app) {
        navigator.app.exitApp();
      }
    });
  });


  $rootScope.$on('Local/WalletImported', function(event, walletId) {
    self.needsBackup = false;
    storageService.setBackupFlag(walletId, function() {
      $log.debug('Backup done stored');
      addressService.expireAddress(walletId, function(err) {
        $timeout(function() {
          self.txHistory = self.completeHistory = [];
            self.startScan(walletId);
        }, 500);
      });
    });
  });

  $rootScope.$on('NewIncomingTx', function() {
    self.updateAll({
      walletStatus: null,
      untilItChanges: true,
      triggerTxUpdate: true,
    });
  });



  $rootScope.$on('NewOutgoingTx', function() {
    self.updateAll({
      walletStatus: null,
      untilItChanges: true,
      triggerTxUpdate: true,
    });
  });

  lodash.each(['NewTxProposal', 'TxProposalFinallyRejected', 'TxProposalRemoved', 'NewOutgoingTxByThirdParty',
    'Local/NewTxProposal', 'Local/TxProposalAction'
  ], function(eventName) {
    $rootScope.$on(eventName, function(event, untilItChanges) {
      self.updateAll({
        walletStatus: null,
        untilItChanges: untilItChanges,
        triggerTxUpdate: true,
      });
    });
  });

  $rootScope.$on('ScanFinished', function() {
    $log.debug('Scan Finished. Updating history');
      self.updateAll({
        walletStatus: null,
        triggerTxUpdate: true,
      });
  });


  $rootScope.$on('Local/NoWallets', function(event) {
    $timeout(function() {
      self.hasProfile = true;
      self.noFocusedWallet = true;
      self.isComplete = null;
      self.walletName = null;
      go.path('import');
    });
  });

  $rootScope.$on('Local/NewFocusedWallet', function() {
      console.log('on Local/NewFocusedWallet');
    self.setFocusedWallet();
    //self.updateTxHistory();
    go.walletHome();
  });

  $rootScope.$on('Local/SetTab', function(event, tab, reset) {
    console.log("SetTab "+tab+", reset "+reset);
    self.setTab(tab, reset);
  });

  $rootScope.$on('Local/RequestTouchid', function(event, cb) {
    window.plugins.touchid.verifyFingerprint(
      gettextCatalog.getString('Scan your fingerprint please'),
      function(msg) {
        // OK
        return cb();
      },
      function(msg) {
        // ERROR
        return cb(gettext('Invalid Touch ID'));
      }
    );
  });

  $rootScope.$on('Local/ShowAlert', function(event, msg, msg_icon, cb) {
      self.showPopup(msg, msg_icon, cb);
  });

  $rootScope.$on('Local/ShowErrorAlert', function(event, msg, cb) {
      self.showErrorPopup(msg, cb);
  });

  $rootScope.$on('Local/NeedsPassword', function(event, isSetup, error_message, cb) {
    console.log('NeedsPassword');
    self.askPassword = {
        isSetup: isSetup,
        error: error_message,
        callback: function(err, pass) {
            self.askPassword = null;
            return cb(err, pass);
        },
    };
    $timeout(function() {
      $rootScope.$apply();
    });
  });

  lodash.each(['NewCopayer', 'CopayerUpdated'], function(eventName) {
    $rootScope.$on(eventName, function() {
      // Re try to open wallet (will triggers)
      self.setFocusedWallet();
    });
  });

  $rootScope.$on('Local/NewEncryptionSetting', function() {
    var fc = profileService.focusedClient;
    self.isPrivKeyEncrypted = fc.isPrivKeyEncrypted();
    $timeout(function() {
      $rootScope.$apply();
    });
  });
});