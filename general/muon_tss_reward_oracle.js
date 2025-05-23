const { axios, Web3, ethGetBlock, BN } = MuonAppUtils;

const HttpProvider = Web3.providers.HttpProvider;
const w3 = new Web3(
  new HttpProvider(
    process.env.WEB3_PROVIDER_AVALANCHE_MAINNET || "https://avalanche-c-chain-rpc.publicnode.com",
  ),
);

const bn = (num) => new BN(num)

const HELPER_ADDR = "0x795707350AFb184d293FCA7A604135568b89c781";
const HELPER_ABI = [{"inputs":[{"internalType":"address","name":"stakerAddress","type":"address"}],"name":"getData","outputs":[{"components":[{"internalType":"uint64","name":"nodeId","type":"uint64"},{"internalType":"address","name":"nodeAddress","type":"address"},{"internalType":"address","name":"stakerAddress","type":"address"},{"internalType":"string","name":"peerId","type":"string"},{"internalType":"bool","name":"active","type":"bool"},{"internalType":"uint8","name":"tier","type":"uint8"},{"internalType":"uint64[]","name":"roles","type":"uint64[]"},{"internalType":"uint256","name":"startTime","type":"uint256"},{"internalType":"uint256","name":"endTime","type":"uint256"},{"internalType":"uint256","name":"lastEditTime","type":"uint256"},{"internalType":"uint256","name":"balance","type":"uint256"},{"internalType":"uint256","name":"paidReward","type":"uint256"},{"internalType":"uint256","name":"paidRewardPerToken","type":"uint256"},{"internalType":"uint256","name":"pendingRewards","type":"uint256"},{"internalType":"uint256","name":"tokenId","type":"uint256"},{"internalType":"uint256","name":"earned","type":"uint256"},{"internalType":"uint256","name":"rewardPerToken","type":"uint256"}],"internalType":"struct Helper.NodeData","name":"nodeData","type":"tuple"}],"stateMutability":"view","type":"function"}];
const helperContract = new w3.eth.Contract(HELPER_ABI, HELPER_ADDR);

const MONITORING_SERVERS = ["https://app.muon.net/monitor"];

const BLACKLIST = []


module.exports = {
  APP_NAME: "muon_tss_reward_oracle",

  getOnlinePercent: async function (nodeId, endTime) {
    let logs = [];
    for (let monitoringServer of MONITORING_SERVERS) {
      const resp = await axios
        .get(`${monitoringServer}/nodes/${nodeId}/status`)
        .then(({ data }) => data.result)
        .catch((err) => {
          console.log(err);
        });
      logs.push(...resp["history"]);
    }

    logs.sort((a, b) => a.timestamp - b.timestamp);

    // filter the extra logs
    const filteredLogs = logs.filter(
      (log, i) =>
        (i == 0 || logs[i - 1].isOnline != log.isOnline) &&
        log.timestamp <= endTime,
    );

    onlineTime = 0;
    filteredLogs.map((log, i) => {
      if (log.isOnline) {
        onlineTime +=
          (filteredLogs[i + 1]?.timestamp || endTime) - log.timestamp;
      }
    });

    const onlinePercent =
      onlineTime > 0
        ? (onlineTime * 100) / (endTime - filteredLogs[0]["timestamp"])
        : 0;

    if (onlinePercent < 0 || onlinePercent > 100) {
      throw "Online percent is out of range.";
    }

    return onlinePercent;
  },

  getRewardPercent: function (onlinePercent) {
    if (onlinePercent >= 90) {
      return 100;
    } else if (onlinePercent >= 50 && onlinePercent < 90) {
      return onlinePercent;
    } else if (onlinePercent < 50) {
      return 0;
    }
  },

  getDataDecoder: function (res) {
    const data = w3.eth.abi.decodeParameters(
      [
        {
          components: [
            { internalType: "uint64", name: "nodeId", type: "uint64" },
            { internalType: "address", name: "nodeAddress", type: "address" },
            { internalType: "address", name: "stakerAddress", type: "address" },
            { internalType: "string", name: "peerId", type: "string" },
            { internalType: "bool", name: "active", type: "bool" },
            { internalType: "uint8", name: "tier", type: "uint8" },
            { internalType: "uint64[]", name: "roles", type: "uint64[]" },
            { internalType: "uint256", name: "startTime", type: "uint256" },
            { internalType: "uint256", name: "endTime", type: "uint256" },
            { internalType: "uint256", name: "lastEditTime", type: "uint256" },
            { internalType: "uint256", name: "balance", type: "uint256" },
            { internalType: "uint256", name: "paidReward", type: "uint256" },
            {
              internalType: "uint256",
              name: "paidRewardPerToken",
              type: "uint256",
            },
            {
              internalType: "uint256",
              name: "pendingRewards",
              type: "uint256",
            },
            { internalType: "uint256", name: "tokenId", type: "uint256" },
            { internalType: "uint256", name: "earned", type: "uint256" },
            {
              internalType: "uint256",
              name: "rewardPerToken",
              type: "uint256",
            },
          ],
          internalType: "struct Helper.NodeData",
          name: "nodeData",
          type: "tuple",
        },
      ],
      res,
    );
    return data["0"];
  },

  onRequest: async function (request) {
    const {
      method,
      data: { params },
    } = request;
    let { stakerAddress, blockNumber } = params;
    blockNumber = Number(blockNumber);

    if(BLACKLIST.map(x => x.toLowerCase()).includes(stakerAddress.toLowerCase())){
      throw "You are not able to claim rewards. Please, contact support.";
    }

    switch (method) {
      case "reward":
        let reward = bn(0);

        const data = helperContract.methods.getData(stakerAddress).encodeABI();
        const callObject = {
          to: HELPER_ADDR,
          data: data,
        };
        const resp = await w3.eth.call(callObject, blockNumber);
        const node = this.getDataDecoder(resp);

        if (node.nodeId == 0) {
          throw "It's not a staker address.";
        }

        const block = await ethGetBlock("avax", blockNumber);
        // if the node is active the endTime is now otherwise endTime is the node exit time
        const endTime =
          node.endTime > 0 ? Number(node.endTime) : Number(block.timestamp);

        // const onlinePercent = await this.getOnlinePercent(node.nodeId, endTime);
        const onlinePercent = 100;

        const rewardPercent = this.getRewardPercent(onlinePercent);

        if (node.active) {
          reward = bn(node.earned).mul(bn(rewardPercent)).div(bn(100));
        } else {
          reward = bn(node.pendingRewards).mul(bn(rewardPercent)).div(bn(100));
        }

        const divisor = bn(10 ** 8);
        reward = reward.div(divisor).mul(divisor);

        return {
          stakerAddress,
          paidReward: node.paidReward.toString(),
          rewardPerToken: node.rewardPerToken.toString(),
          reward: reward.toString(),
        };

      default:
        throw `Unknown method ${method}`;
    }
  },

  signParams: function (request, result) {
    let { method } = request;
    let { stakerAddress, paidReward, rewardPerToken, reward } = result;

    switch (method) {
      case "reward":
        return [
          { type: "address", value: stakerAddress },
          { type: "uint256", value: paidReward },
          {
            type: "uint256",
            value: rewardPerToken,
          },
          { type: "uint256", value: reward },
        ];

      default:
        throw `Unknown method ${method}`;
    }
  },
};