pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract TrafficDePINReFiFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    address public owner;
    mapping(address => bool) public isProvider;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    struct Batch {
        uint256 id;
        bool isOpen;
        uint256 totalEncryptedCongestionScore;
        uint256 totalEncryptedEcoScore;
        uint256 submissionCount;
    }
    Batch public currentBatch;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event ContractPaused(address indexed account);
    event ContractUnpaused(address indexed account);
    event CooldownSecondsUpdated(uint256 oldCooldown, uint256 newCooldown);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event DataSubmitted(address indexed provider, uint256 indexed batchId);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint256 totalCongestionScore, uint256 totalEcoScore);

    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error BatchNotOpen();
    error InvalidBatchId();
    error ReplayAttempt();
    error StateMismatch();
    error InvalidProof();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
        lastSubmissionTime[msg.sender] = block.timestamp;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier submissionRateLimited() {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    modifier decryptionRateLimited() {
        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
        lastDecryptionRequestTime[msg.sender] = block.timestamp;
    }

    constructor() {
        owner = msg.sender;
        cooldownSeconds = 60; // Default 1 minute cooldown
        currentBatch = Batch({id: 1, isOpen: false, totalEncryptedCongestionScore: 0, totalEncryptedEcoScore: 0, submissionCount: 0});
    }

    function transferOwnership(address newOwner) external onlyOwner {
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function addProvider(address provider) external onlyOwner {
        if (!isProvider[provider]) {
            isProvider[provider] = true;
            emit ProviderAdded(provider);
        }
    }

    function removeProvider(address provider) external onlyOwner {
        if (isProvider[provider]) {
            isProvider[provider] = false;
            emit ProviderRemoved(provider);
        }
    }

    function pause() external onlyOwner whenNotPaused {
        paused = true;
        emit ContractPaused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit ContractUnpaused(msg.sender);
    }

    function setCooldownSeconds(uint256 newCooldownSeconds) external onlyOwner {
        require(newCooldownSeconds > 0, "Cooldown must be positive");
        emit CooldownSecondsUpdated(cooldownSeconds, newCooldownSeconds);
        cooldownSeconds = newCooldownSeconds;
    }

    function openBatch() external onlyOwner whenNotPaused {
        if (currentBatch.isOpen) {
            currentBatch.isOpen = false; // Close current if open
            emit BatchClosed(currentBatch.id);
        }
        currentBatch = Batch({id: currentBatch.id + 1, isOpen: true, totalEncryptedCongestionScore: 0, totalEncryptedEcoScore: 0, submissionCount: 0});
        emit BatchOpened(currentBatch.id);
    }

    function closeBatch() external onlyOwner whenNotPaused {
        if (!currentBatch.isOpen) revert BatchNotOpen();
        currentBatch.isOpen = false;
        emit BatchClosed(currentBatch.id);
    }

    function submitData(euint32 encryptedCongestionScore, euint32 encryptedEcoScore) external onlyProvider whenNotPaused submissionRateLimited {
        if (!currentBatch.isOpen) revert BatchNotOpen();
        if (!encryptedCongestionScore.isInitialized()) revert("Congestion score not initialized");
        if (!encryptedEcoScore.isInitialized()) revert("Eco score not initialized");

        currentBatch.totalEncryptedCongestionScore = FHE.add(currentBatch.totalEncryptedCongestionScore, encryptedCongestionScore);
        currentBatch.totalEncryptedEcoScore = FHE.add(currentBatch.totalEncryptedEcoScore, encryptedEcoScore);
        currentBatch.submissionCount++;
        emit DataSubmitted(msg.sender, currentBatch.id);
    }

    function requestBatchDecryption() external onlyOwner whenNotPaused decryptionRateLimited {
        if (currentBatch.isOpen) revert BatchNotOpen();
        if (currentBatch.submissionCount == 0) revert("No data to decrypt");

        euint32 memory totalCongestionScoreEnc = euint32(currentBatch.totalEncryptedCongestionScore);
        euint32 memory totalEcoScoreEnc = euint32(currentBatch.totalEncryptedEcoScore);

        bytes32[] memory cts = new bytes32[](2);
        cts[0] = FHE.toBytes32(totalCongestionScoreEnc);
        cts[1] = FHE.toBytes32(totalEcoScoreEnc);

        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);
        decryptionContexts[requestId] = DecryptionContext({ batchId: currentBatch.id, stateHash: stateHash, processed: false });
        emit DecryptionRequested(requestId, currentBatch.id);
    }

    function myCallback(uint256 requestId, bytes memory cleartexts, bytes memory proof) public {
        if (requestId == 0) revert("Invalid request ID");

        DecryptionContext storage ctx = decryptionContexts[requestId];
        if (ctx.processed) revert ReplayAttempt();

        Batch storage batch = currentBatch;
        if (batch.id != ctx.batchId) revert InvalidBatchId();

        euint32 memory totalCongestionScoreEnc = euint32(batch.totalEncryptedCongestionScore);
        euint32 memory totalEcoScoreEnc = euint32(batch.totalEncryptedEcoScore);

        bytes32[] memory cts = new bytes32[](2);
        cts[0] = FHE.toBytes32(totalCongestionScoreEnc);
        cts[1] = FHE.toBytes32(totalEcoScoreEnc);

        bytes32 currentHash = _hashCiphertexts(cts);
        if (currentHash != ctx.stateHash) {
            revert StateMismatch();
        }

        try FHE.checkSignatures(requestId, cleartexts, proof) {
            // Decode cleartexts in the same order as cts
            (uint32 totalCongestionScoreCleartext, uint32 totalEcoScoreCleartext) = abi.decode(cleartexts, (uint32, uint32));

            ctx.processed = true;
            emit DecryptionCompleted(requestId, ctx.batchId, totalCongestionScoreCleartext, totalEcoScoreCleartext);
        } catch {
            revert InvalidProof();
        }
    }

    function _hashCiphertexts(bytes32[] memory cts) internal view returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }
}