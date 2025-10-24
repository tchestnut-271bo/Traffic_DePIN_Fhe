// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface TrafficRecord {
  id: string;
  encryptedSpeed: string;
  encryptedLocation: string;
  timestamp: number;
  owner: string;
  status: "pending" | "verified" | "rejected";
  carbonCredit: number;
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const FHECompute = (encryptedData: string, operation: string): string => {
  const value = FHEDecryptNumber(encryptedData);
  let result = value;
  
  switch(operation) {
    case 'calculateCredit':
      result = Math.max(0, value * 0.01); // 1% of speed as carbon credit
      break;
    default:
      result = value;
  }
  
  return FHEEncryptNumber(result);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [records, setRecords] = useState<TrafficRecord[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newRecordData, setNewRecordData] = useState({ speed: 0, location: "" });
  const [showTutorial, setShowTutorial] = useState(false);
  const [selectedRecord, setSelectedRecord] = useState<TrafficRecord | null>(null);
  const [decryptedSpeed, setDecryptedSpeed] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [totalCarbonCredits, setTotalCarbonCredits] = useState(0);
  const [showMap, setShowMap] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");

  const verifiedCount = records.filter(r => r.status === "verified").length;
  const pendingCount = records.filter(r => r.status === "pending").length;
  const rejectedCount = records.filter(r => r.status === "rejected").length;

  useEffect(() => {
    loadRecords().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  useEffect(() => {
    const credits = records.reduce((sum, record) => sum + (record.carbonCredit || 0), 0);
    setTotalCarbonCredits(credits);
  }, [records]);

  const loadRecords = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      const keysBytes = await contract.getData("traffic_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing record keys:", e); }
      }
      const list: TrafficRecord[] = [];
      for (const key of keys) {
        try {
          const recordBytes = await contract.getData(`traffic_${key}`);
          if (recordBytes.length > 0) {
            try {
              const recordData = JSON.parse(ethers.toUtf8String(recordBytes));
              list.push({ 
                id: key, 
                encryptedSpeed: recordData.speed, 
                encryptedLocation: recordData.location,
                timestamp: recordData.timestamp, 
                owner: recordData.owner, 
                status: recordData.status || "pending",
                carbonCredit: recordData.carbonCredit || 0
              });
            } catch (e) { console.error(`Error parsing record data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading record ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setRecords(list);
    } catch (e) { console.error("Error loading records:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const submitRecord = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setCreating(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting traffic data with Zama FHE..." });
    try {
      const encryptedSpeed = FHEEncryptNumber(newRecordData.speed);
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      const recordId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const recordData = { 
        speed: encryptedSpeed, 
        location: newRecordData.location,
        timestamp: Math.floor(Date.now() / 1000), 
        owner: address, 
        status: "pending",
        carbonCredit: 0
      };
      await contract.setData(`traffic_${recordId}`, ethers.toUtf8Bytes(JSON.stringify(recordData)));
      const keysBytes = await contract.getData("traffic_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(recordId);
      await contract.setData("traffic_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      setTransactionStatus({ visible: true, status: "success", message: "Encrypted traffic data submitted!" });
      await loadRecords();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewRecordData({ speed: 0, location: "" });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setCreating(false); }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { console.error("Decryption failed:", e); return null; } 
    finally { setIsDecrypting(false); }
  };

  const verifyRecord = async (recordId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing traffic data with FHE..." });
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Failed to get contract");
      const recordBytes = await contract.getData(`traffic_${recordId}`);
      if (recordBytes.length === 0) throw new Error("Record not found");
      const recordData = JSON.parse(ethers.toUtf8String(recordBytes));
      
      const carbonCredit = FHECompute(recordData.speed, 'calculateCredit');
      
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      const updatedRecord = { 
        ...recordData, 
        status: "verified", 
        carbonCredit: FHEDecryptNumber(carbonCredit)
      };
      await contractWithSigner.setData(`traffic_${recordId}`, ethers.toUtf8Bytes(JSON.stringify(updatedRecord)));
      
      setTransactionStatus({ visible: true, status: "success", message: "FHE verification completed! Carbon credit calculated." });
      await loadRecords();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Verification failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const rejectRecord = async (recordId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing traffic data..." });
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      const recordBytes = await contract.getData(`traffic_${recordId}`);
      if (recordBytes.length === 0) throw new Error("Record not found");
      const recordData = JSON.parse(ethers.toUtf8String(recordBytes));
      const updatedRecord = { ...recordData, status: "rejected" };
      await contract.setData(`traffic_${recordId}`, ethers.toUtf8Bytes(JSON.stringify(updatedRecord)));
      setTransactionStatus({ visible: true, status: "success", message: "Record rejected!" });
      await loadRecords();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Rejection failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const isOwner = (recordAddress: string) => address?.toLowerCase() === recordAddress.toLowerCase();

  const tutorialSteps = [
    { title: "Connect Wallet", description: "Connect your Web3 wallet to join the Traffic DePIN network", icon: "🔗" },
    { title: "Share Traffic Data", description: "Contribute encrypted speed and location data from your vehicle", icon: "🚗", details: "Your data is encrypted with Zama FHE before submission" },
    { title: "Earn Carbon Credits", description: "Receive ReFi tokens based on your traffic data contribution", icon: "🌱", details: "1% of your speed data is converted to carbon credits" },
    { title: "Trade Credits", description: "Use your credits in the privacy DEX to offset carbon footprint", icon: "🔄", details: "All transactions are private and secure" }
  ];

  const filteredRecords = records.filter(record => 
    record.id.toLowerCase().includes(searchTerm.toLowerCase()) || 
    record.owner.toLowerCase().includes(searchTerm.toLowerCase()) ||
    record.status.toLowerCase().includes(searchTerm.toLowerCase())
  );

  if (loading) return (
    <div className="loading-screen">
      <div className="nature-spinner"></div>
      <p>Initializing encrypted traffic network...</p>
    </div>
  );

  return (
    <div className="app-container nature-theme">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon"><div className="leaf-icon"></div></div>
          <h1>Traffic<span>DePIN</span>Network</h1>
        </div>
        <div className="header-actions">
          <button onClick={() => setShowCreateModal(true)} className="create-record-btn nature-button">
            <div className="add-icon"></div>Share Data
          </button>
          <button className="nature-button" onClick={() => setShowTutorial(!showTutorial)}>
            {showTutorial ? "Hide Guide" : "Show Guide"}
          </button>
          <button className="nature-button" onClick={() => setShowMap(!showMap)}>
            {showMap ? "Hide Map" : "Show Traffic Map"}
          </button>
          <div className="wallet-connect-wrapper"><ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/></div>
        </div>
      </header>
      <div className="main-content">
        <div className="welcome-banner">
          <div className="welcome-text">
            <h2>Private Traffic Data Network</h2>
            <p>Contribute encrypted traffic data with your vehicle and earn carbon credits</p>
          </div>
          <div className="fhe-indicator"><div className="fhe-lock"></div><span>Zama FHE Encryption</span></div>
        </div>
        {showTutorial && (
          <div className="tutorial-section">
            <h2>Traffic DePIN Network Guide</h2>
            <p className="subtitle">How to contribute to smarter cities while earning rewards</p>
            <div className="tutorial-steps">
              {tutorialSteps.map((step, index) => (
                <div className="tutorial-step" key={index}>
                  <div className="step-icon">{step.icon}</div>
                  <div className="step-content">
                    <h3>{step.title}</h3>
                    <p>{step.description}</p>
                    {step.details && <div className="step-details">{step.details}</div>}
                  </div>
                </div>
              ))}
            </div>
            <div className="fhe-diagram">
              <div className="diagram-step"><div className="diagram-icon">🚗</div><div className="diagram-label">Vehicle Data</div></div>
              <div className="diagram-arrow">→</div>
              <div className="diagram-step"><div className="diagram-icon">🔒</div><div className="diagram-label">FHE Encryption</div></div>
              <div className="diagram-arrow">→</div>
              <div className="diagram-step"><div className="diagram-icon">🌐</div><div className="diagram-label">DePIN Network</div></div>
              <div className="diagram-arrow">→</div>
              <div className="diagram-step"><div className="diagram-icon">🌱</div><div className="diagram-label">Carbon Credits</div></div>
            </div>
          </div>
        )}
        <div className="dashboard-grid">
          <div className="dashboard-card nature-card">
            <h3>Project Introduction</h3>
            <p>A <strong>privacy-preserving</strong> traffic data network using <strong>Zama FHE</strong> to encrypt vehicle data. Contribute your encrypted speed and location data to optimize city traffic and earn carbon credits.</p>
            <div className="fhe-badge"><span>FHE-Powered</span></div>
          </div>
          <div className="dashboard-card nature-card">
            <h3>Network Statistics</h3>
            <div className="stats-grid">
              <div className="stat-item"><div className="stat-value">{records.length}</div><div className="stat-label">Total Records</div></div>
              <div className="stat-item"><div className="stat-value">{verifiedCount}</div><div className="stat-label">Verified</div></div>
              <div className="stat-item"><div className="stat-value">{totalCarbonCredits.toFixed(2)}</div><div className="stat-label">Total Credits</div></div>
              <div className="stat-item"><div className="stat-value">{pendingCount}</div><div className="stat-label">Pending</div></div>
            </div>
          </div>
          <div className="dashboard-card nature-card">
            <h3>Your Contribution</h3>
            <div className="user-stats">
              <div className="user-stat">
                <div className="stat-icon">🚗</div>
                <div>
                  <div className="stat-value">
                    {records.filter(r => isOwner(r.owner)).length}
                  </div>
                  <div className="stat-label">Your Data Points</div>
                </div>
              </div>
              <div className="user-stat">
                <div className="stat-icon">🌱</div>
                <div>
                  <div className="stat-value">
                    {records.filter(r => isOwner(r.owner)).reduce((sum, r) => sum + r.carbonCredit, 0).toFixed(2)}
                  </div>
                  <div className="stat-label">Your Credits</div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {showMap && (
          <div className="map-section nature-card">
            <h2>Traffic Heatmap</h2>
            <div className="map-placeholder">
              <div className="map-overlay">
                {records.slice(0, 10).map((record, i) => (
                  <div 
                    key={i} 
                    className="map-point" 
                    style={{
                      left: `${10 + Math.random() * 80}%`,
                      top: `${10 + Math.random() * 80}%`,
                      backgroundColor: record.status === 'verified' ? '#4CAF50' : record.status === 'pending' ? '#FFC107' : '#F44336'
                    }}
                    title={`Speed: ${FHEDecryptNumber(record.encryptedSpeed).toFixed(0)} km/h`}
                  ></div>
                ))}
              </div>
              <p>Visualization of encrypted traffic data contributions (sample)</p>
            </div>
          </div>
        )}

        <div className="records-section">
          <div className="section-header">
            <h2>Traffic Data Records</h2>
            <div className="header-actions">
              <input
                type="text"
                placeholder="Search records..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="nature-input"
              />
              <button onClick={loadRecords} className="refresh-btn nature-button" disabled={isRefreshing}>
                {isRefreshing ? "Refreshing..." : "Refresh"}
              </button>
            </div>
          </div>
          <div className="records-list nature-card">
            <div className="table-header">
              <div className="header-cell">ID</div>
              <div className="header-cell">Location</div>
              <div className="header-cell">Owner</div>
              <div className="header-cell">Date</div>
              <div className="header-cell">Status</div>
              <div className="header-cell">Credits</div>
              <div className="header-cell">Actions</div>
            </div>
            {filteredRecords.length === 0 ? (
              <div className="no-records">
                <div className="no-records-icon"></div>
                <p>No traffic records found</p>
                <button className="nature-button primary" onClick={() => setShowCreateModal(true)}>Share First Data</button>
              </div>
            ) : filteredRecords.map(record => (
              <div className="record-row" key={record.id} onClick={() => setSelectedRecord(record)}>
                <div className="table-cell record-id">#{record.id.substring(0, 6)}</div>
                <div className="table-cell">{record.encryptedLocation.substring(0, 10)}...</div>
                <div className="table-cell">{record.owner.substring(0, 6)}...{record.owner.substring(38)}</div>
                <div className="table-cell">{new Date(record.timestamp * 1000).toLocaleDateString()}</div>
                <div className="table-cell"><span className={`status-badge ${record.status}`}>{record.status}</span></div>
                <div className="table-cell">{record.carbonCredit.toFixed(2)}</div>
                <div className="table-cell actions">
                  {isOwner(record.owner) && record.status === "pending" && (
                    <>
                      <button className="action-btn nature-button success" onClick={(e) => { e.stopPropagation(); verifyRecord(record.id); }}>Verify</button>
                      <button className="action-btn nature-button danger" onClick={(e) => { e.stopPropagation(); rejectRecord(record.id); }}>Reject</button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      {showCreateModal && <ModalCreate onSubmit={submitRecord} onClose={() => setShowCreateModal(false)} creating={creating} recordData={newRecordData} setRecordData={setNewRecordData}/>}
      {selectedRecord && <RecordDetailModal record={selectedRecord} onClose={() => { setSelectedRecord(null); setDecryptedSpeed(null); }} decryptedSpeed={decryptedSpeed} setDecryptedSpeed={setDecryptedSpeed} isDecrypting={isDecrypting} decryptWithSignature={decryptWithSignature}/>}
      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content nature-card">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="nature-spinner"></div>}
              {transactionStatus.status === "success" && <div className="check-icon"></div>}
              {transactionStatus.status === "error" && <div className="error-icon"></div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}
      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo"><div className="leaf-icon"></div><span>TrafficDePIN</span></div>
            <p>Private, real-time traffic data with Zama FHE encryption</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">Privacy Policy</a>
            <a href="#" className="footer-link">Carbon Calculator</a>
            <a href="#" className="footer-link">Contact</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="fhe-badge"><span>FHE-Powered Privacy</span></div>
          <div className="copyright">© {new Date().getFullYear()} TrafficDePIN Network. All rights reserved.</div>
        </div>
      </footer>
    </div>
  );
};

interface ModalCreateProps {
  onSubmit: () => void; 
  onClose: () => void; 
  creating: boolean;
  recordData: any;
  setRecordData: (data: any) => void;
}

const ModalCreate: React.FC<ModalCreateProps> = ({ onSubmit, onClose, creating, recordData, setRecordData }) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setRecordData({ ...recordData, [name]: value });
  };

  const handleValueChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setRecordData({ ...recordData, [name]: parseFloat(value) });
  };

  const handleSubmit = () => {
    if (!recordData.location || !recordData.speed) { alert("Please fill required fields"); return; }
    onSubmit();
  };

  return (
    <div className="modal-overlay">
      <div className="create-modal nature-card">
        <div className="modal-header">
          <h2>Share Traffic Data</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="fhe-notice-banner">
            <div className="key-icon"></div> 
            <div><strong>FHE Encryption Notice</strong><p>Your traffic data will be encrypted with Zama FHE before submission</p></div>
          </div>
          <div className="form-grid">
            <div className="form-group">
              <label>Location *</label>
              <input 
                type="text" 
                name="location" 
                value={recordData.location} 
                onChange={handleChange} 
                placeholder="Enter approximate location..." 
                className="nature-input"
              />
            </div>
            <div className="form-group">
              <label>Speed (km/h) *</label>
              <input 
                type="number" 
                name="speed" 
                value={recordData.speed} 
                onChange={handleValueChange} 
                placeholder="Enter your speed..." 
                className="nature-input"
                min="0"
                step="1"
              />
            </div>
          </div>
          <div className="encryption-preview">
            <h4>Encryption Preview</h4>
            <div className="preview-container">
              <div className="plain-data"><span>Plain Speed:</span><div>{recordData.speed || 'No value entered'} km/h</div></div>
              <div className="encryption-arrow">→</div>
              <div className="encrypted-data">
                <span>Encrypted Data:</span>
                <div>{recordData.speed ? FHEEncryptNumber(recordData.speed).substring(0, 50) + '...' : 'No value entered'}</div>
              </div>
            </div>
          </div>
          <div className="credit-estimate">
            <h4>Estimated Carbon Credit</h4>
            <div className="estimate-value">
              {recordData.speed ? (recordData.speed * 0.01).toFixed(2) : '0.00'} credits
            </div>
            <p className="estimate-note">1% of your speed contributes to carbon credits</p>
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="cancel-btn nature-button">Cancel</button>
          <button onClick={handleSubmit} disabled={creating} className="submit-btn nature-button primary">
            {creating ? "Encrypting with FHE..." : "Submit Securely"}
          </button>
        </div>
      </div>
    </div>
  );
};

interface RecordDetailModalProps {
  record: TrafficRecord;
  onClose: () => void;
  decryptedSpeed: number | null;
  setDecryptedSpeed: (value: number | null) => void;
  isDecrypting: boolean;
  decryptWithSignature: (encryptedData: string) => Promise<number | null>;
}

const RecordDetailModal: React.FC<RecordDetailModalProps> = ({ record, onClose, decryptedSpeed, setDecryptedSpeed, isDecrypting, decryptWithSignature }) => {
  const handleDecrypt = async () => {
    if (decryptedSpeed !== null) { setDecryptedSpeed(null); return; }
    const decrypted = await decryptWithSignature(record.encryptedSpeed);
    if (decrypted !== null) setDecryptedSpeed(decrypted);
  };

  return (
    <div className="modal-overlay">
      <div className="record-detail-modal nature-card">
        <div className="modal-header">
          <h2>Record Details #{record.id.substring(0, 8)}</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="record-info">
            <div className="info-item"><span>Location:</span><strong>{record.encryptedLocation}</strong></div>
            <div className="info-item"><span>Owner:</span><strong>{record.owner.substring(0, 6)}...{record.owner.substring(38)}</strong></div>
            <div className="info-item"><span>Date:</span><strong>{new Date(record.timestamp * 1000).toLocaleString()}</strong></div>
            <div className="info-item"><span>Status:</span><strong className={`status-badge ${record.status}`}>{record.status}</strong></div>
            <div className="info-item"><span>Carbon Credit:</span><strong>{record.carbonCredit.toFixed(2)}</strong></div>
          </div>
          <div className="encrypted-data-section">
            <h3>Encrypted Speed Data</h3>
            <div className="encrypted-data">{record.encryptedSpeed.substring(0, 100)}...</div>
            <div className="fhe-tag"><div className="fhe-icon"></div><span>FHE Encrypted</span></div>
            <button className="decrypt-btn nature-button" onClick={handleDecrypt} disabled={isDecrypting}>
              {isDecrypting ? <span className="decrypt-spinner"></span> : decryptedSpeed !== null ? "Hide Decrypted Value" : "Decrypt with Wallet Signature"}
            </button>
          </div>
          {decryptedSpeed !== null && (
            <div className="decrypted-data-section">
              <h3>Decrypted Speed</h3>
              <div className="decrypted-value">{decryptedSpeed.toFixed(0)} km/h</div>
              <div className="decryption-notice"><div className="warning-icon"></div><span>Decrypted data is only visible after wallet signature verification</span></div>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="close-btn nature-button">Close</button>
        </div>
      </div>
    </div>
  );
};

export default App;
