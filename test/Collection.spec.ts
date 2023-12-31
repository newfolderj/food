import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";

import {
  AccountRegistry,
  Collection,
  CollectionFactory,
  Collection__factory,
  NodeRegistry,
  TestEngine,
} from "../typechain-types";
import { constants } from "ethers";
import { createCreateNode, currentTimestamp } from "./_fixtures";

describe("CollectionFactory.sol", () => {
  // ---
  // fixtures
  // ---

  let Collection: Collection__factory;
  let testEngine: TestEngine;
  let accountRegistry: AccountRegistry;
  let nodeRegistry: NodeRegistry;
  let factory: CollectionFactory;
  let accounts: SignerWithAddress[];
  let a0: string, a1: string, a2: string, a3: string;
  let createNode: ReturnType<typeof createCreateNode>;

  beforeEach(async () => {
    Collection = (await ethers.getContractFactory(
      "Collection"
    )) as Collection__factory;
    const AccountRegistry = await ethers.getContractFactory("AccountRegistry");
    const NodeRegistry = await ethers.getContractFactory("NodeRegistry");
    const CollectionFactory = await ethers.getContractFactory(
      "CollectionFactory"
    );
    const TestEngine = await ethers.getContractFactory("TestEngine");

    accountRegistry = (await AccountRegistry.deploy(
      constants.AddressZero
    )) as AccountRegistry;
    nodeRegistry = (await NodeRegistry.deploy(
      accountRegistry.address
    )) as NodeRegistry;
    testEngine = (await TestEngine.deploy()) as TestEngine;
    const implementation = await Collection.deploy();
    factory = (await CollectionFactory.deploy(
      nodeRegistry.address,
      implementation.address
    )) as CollectionFactory;

    accounts = await ethers.getSigners();
    [a0, a1, a2, a3] = accounts.map((a) => a.address);

    // standard setup
    await accountRegistry.createAccount(a0, "");
    await nodeRegistry.createNode(1, 1, 0, 0, [], "metalabel 1");
    createNode = createCreateNode(accounts, nodeRegistry);
  });

  const createCollection = async (
    name = "Test",
    symbol = "TEST",
    controlNode = 1,
    owner = a0
  ): Promise<Collection> => {
    const trx = await factory.createCollection(
      name,
      symbol,
      controlNode,
      owner,
      "collectionURI"
    );
    const mined = await trx.wait();
    const address = mined.events?.[2].args?.collection;
    const collection = Collection.attach(address);
    return collection;
  };

  const seqConfig = () => {
    return {
      dropNodeId: 1,
      engine: testEngine.address,
      sealedAfterTimestamp: 0,
      sealedBeforeTimestamp: 0,
      maxSupply: 10000,
      minted: 0,
    };
  };

  // ---
  // cases
  // ---

  describe("clone deployment", () => {
    it("deploy a clone collection", async () => {
      const collection = await createCollection("A", "B");
      expect(await collection.name()).to.equal("A");
      expect(await collection.symbol()).to.equal("B");
    });
    it("should revert if attempting to init more than once", async () => {
      const collection = await createCollection("A", "B");
      await expect(collection.init("A", "B", a0, "")).to.be.revertedWith(
        "AlreadyInitialized"
      );
    });
    it("should revert if attempting to init implementation", async () => {
      const collection = Collection.attach(await factory.implementation());
      await expect(collection.init("A", "B", a0, "")).to.be.revertedWith(
        "AlreadyInitialized"
      );
    });
    it("should set contractURI", async () => {
      const collection = await createCollection("A", "B");
      expect(await collection.contractURI()).to.equal("collectionURI");
    });
    it("should properly read from immutable args for node registry", async () => {
      const collection = await createCollection("A", "B");
      expect(await collection.nodeRegistry()).to.equal(nodeRegistry.address);
    });
    it("should properly read from immutable args for control node", async () => {
      const collection = await createCollection("A", "B");
      expect(await collection.controlNode()).to.equal(1);
    });
  });

  describe("Collection.sol", () => {
    it("should allow setting owner", async () => {
      const collection = await createCollection("A", "B");
      await collection.setOwner(a1);
      expect(await collection.owner()).to.equal(a1);
    });
    it("should revert if non authorized account tries to set owner", async () => {
      const collection = await createCollection("A", "B");
      await expect(
        collection.connect(accounts[1]).setOwner(a1)
      ).to.be.revertedWith("NotAuthorized");
    });
    it("should allow minting with a simple engine", async () => {
      const collection = await createCollection("A", "B");
      await createNode({ owner: 0, parent: 1, groupNode: 1 }); // node 2
      await collection.configureSequence({ ...seqConfig(), dropNodeId: 2 }, []);

      await testEngine.mint(collection.address, 1);
      await testEngine.mint(collection.address, 1);
      expect(await collection.totalSupply()).to.equal(2);
      expect(await collection.balanceOf(a0)).to.equal(2);
      expect(await collection.ownerOf(1)).to.equal(a0);
      expect(await collection.tokenURI(1)).to.equal(
        "ipfs://QmURW9DGiSD8N2Dc85ToDypqhbTedzwgnjmCR732TzcSHF"
      );
      expect((await collection.royaltyInfo(1, 100))[0]).to.equal(
        constants.AddressZero
      );
      expect((await collection.royaltyInfo(1, 100))[1]).to.equal(0);
      expect(await collection.supportsInterface("0x80ac58cd")).to.equal(true);
      expect(Number((await collection.getTokenData(1)).data)).to.be.greaterThan(
        0
      );
    });
    it("should allow setting contractURI", async () => {
      const collection = await createCollection("A", "B");
      await collection.broadcastAndStore("metadata", "new URI");
      expect(await collection.contractURI()).to.equal("new URI");
    });
    it("should revert if attempting to deploy collection to non managed node", async () => {
      await expect(
        factory.createCollection("A", "B", 2, a0, "collectionURI")
      ).to.be.revertedWith("NotAuthorized");
    });
    it("should revert if attempting to configure a sequence without node access", async () => {
      const collection = await createCollection("A", "B");
      await accountRegistry.createAccount(a1, ""); // 2
      await createNode({ owner: 2 }, accounts[1]); // node 2
      await expect(
        collection.configureSequence({ ...seqConfig(), dropNodeId: 2 }, [])
      ).to.be.revertedWith("NotAuthorized");
    });
    it("should revert if passing in a non-zero initial minted value to sequence config", async () => {
      const collection = await createCollection("A", "B");
      await expect(
        collection.configureSequence({ ...seqConfig(), minted: 1 }, [])
      ).to.be.revertedWith("InvalidSequenceConfig");
    });
  });
  describe("minting semantics", () => {
    it("should revert if non-engine attempts to mint", async () => {
      const collection = await createCollection("A", "B");
      await collection.configureSequence({ ...seqConfig() }, []);
      await expect(
        collection["mintRecord(address,uint16)"](a0, 1)
      ).to.be.revertedWith("InvalidMintRequest");
    });
    it("should revert if minting before mint window", async () => {
      const now = await currentTimestamp();
      const collection = await createCollection("A", "B");

      await collection.configureSequence(
        { ...seqConfig(), sealedBeforeTimestamp: now + 1000 },
        []
      );
      await expect(testEngine.mint(collection.address, 1)).to.be.revertedWith(
        "SequenceIsSealed"
      );
    });
    it("should revert if minting after mint window", async () => {
      const now = await currentTimestamp();
      const collection = await createCollection("A", "B");

      await collection.configureSequence(
        { ...seqConfig(), sealedAfterTimestamp: now },
        []
      );
      await expect(testEngine.mint(collection.address, 1)).to.be.revertedWith(
        "SequenceIsSealed"
      );
    });
    it("should revert if minting more than max supply", async () => {
      const now = await currentTimestamp();
      const collection = await createCollection("A", "B");

      await collection.configureSequence({ ...seqConfig(), maxSupply: 1 }, []);
      await testEngine.mint(collection.address, 1);
      await expect(testEngine.mint(collection.address, 1)).to.be.revertedWith(
        "SequenceSupplyExhausted"
      );
    });
  });
});
