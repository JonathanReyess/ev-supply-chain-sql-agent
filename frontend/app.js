// Configuration
const API_ENDPOINTS = {
    'sql-of-thought-summary': 'http://localhost:8000/query',
    'sql-of-thought-embeddings': 'http://localhost:8001/query',
    'docking-agent': 'http://localhost:8088/qa'
};

// State
let currentAgent = 'sql-of-thought-summary';
let conversationHistory = [];
let sessionTokens = {
    'sql-of-thought-summary': { totalPromptTokens: 0, totalCompletionTokens: 0, totalTokens: 0 },
    'sql-of-thought-embeddings': { totalPromptTokens: 0, totalCompletionTokens: 0, totalTokens: 0 },
    'docking-agent': { totalPromptTokens: 0, totalCompletionTokens: 0, totalTokens: 0 }
};

// DOM Elements
const agentSelect = document.getElementById('agentSelect');
const messageInput = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');
const messagesContainer = document.getElementById('messages');
const welcomeScreen = document.getElementById('welcomeScreen');
const newChatBtn = document.getElementById('newChatBtn');
const currentAgentLabel = document.getElementById('currentAgent');

// Event Listeners
agentSelect.addEventListener('change', (e) => {
    currentAgent = e.target.value;
    updateAgentLabel();
});

sendBtn.addEventListener('click', sendMessage);

messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});

messageInput.addEventListener('input', () => {
    // Auto-resize textarea
    messageInput.style.height = 'auto';
    messageInput.style.height = messageInput.scrollHeight + 'px';
});

newChatBtn.addEventListener('click', () => {
    if (conversationHistory.length > 0) {
        if (!confirm('Start a new conversation? This will clear your current chat history.')) {
            return;
        }
    }
    conversationHistory = [];
    messagesContainer.innerHTML = '';
    welcomeScreen.style.display = 'block';
    messageInput.value = '';
    // Reset session tokens for current agent
    sessionTokens[currentAgent] = { totalPromptTokens: 0, totalCompletionTokens: 0, totalTokens: 0 };
    console.log('🆕 New conversation started');
});

// Handle example prompt clicks
document.querySelectorAll('.prompt-card').forEach(card => {
    card.addEventListener('click', () => {
        const prompt = card.getAttribute('data-prompt');
        messageInput.value = prompt;
        
        // Switch agent based on prompt
        if (prompt.toLowerCase().includes('eta') || 
            prompt.toLowerCase().includes('door') || 
            prompt.toLowerCase().includes('dock')) {
            agentSelect.value = 'docking-agent';
            currentAgent = 'docking-agent';
        } else {
            // Default to summary version for SQL questions
            agentSelect.value = 'sql-of-thought-summary';
            currentAgent = 'sql-of-thought-summary';
        }
        updateAgentLabel();
        sendMessage();
    });
});

// Functions
function updateAgentLabel() {
    const agentNames = {
        'sql-of-thought-summary': 'SQL-of-Thought (Summary)',
        'sql-of-thought-embeddings': 'SQL-of-Thought (Embeddings)',
        'docking-agent': 'Docking Agent'
    };
    currentAgentLabel.textContent = agentNames[currentAgent];
}

async function sendMessage() {
    const message = messageInput.value.trim();
    if (!message) return;

    // Hide welcome screen
    welcomeScreen.style.display = 'none';

    // Add user message with context indicator
    const contextCount = conversationHistory.filter(t => t.agent === currentAgent).length;
    let userMessageHtml = message;
    if (contextCount > 0) {
        userMessageHtml += `<br><small style="color: #888; font-size: 11px;">📚 Using ${contextCount} previous turn${contextCount > 1 ? 's' : ''} as context</small>`;
    }
    addMessage(userMessageHtml, 'user');
    
    // Clear input
    messageInput.value = '';
    messageInput.style.height = 'auto';

    // Disable send button
    sendBtn.disabled = true;

    // Add loading message
    const loadingId = addMessage('', 'assistant', true);

    try {
        const response = await queryAgent(currentAgent, message);
        
        // Remove loading message
        removeMessage(loadingId);
        
        // Add assistant response
        addMessage(formatResponse(response, currentAgent), 'assistant');
        
        // Save to history with enhanced metadata
        const historyEntry = {
            question: message,
            sql: response.sql || null,
            results: response.results || response.answer,
            agent: currentAgent,
            timestamp: new Date().toISOString()
        };
        
        // Add enhanced metadata for SQL-of-Thought
        if (currentAgent === 'sql-of-thought' && response.metadata) {
            historyEntry.tables = response.metadata.tables || [];
            historyEntry.rowCount = response.metadata.rowCount || 0;
            historyEntry.keyMetric = response.metadata.keyMetric || '';
            console.log('[DEBUG] Saved history with metadata:', {
                question: historyEntry.question.substring(0, 50),
                tables: historyEntry.tables,
                keyMetric: historyEntry.keyMetric
            });
        }
        
        conversationHistory.push(historyEntry);
        console.log('[DEBUG] Conversation history length:', conversationHistory.length);
    } catch (error) {
        // Remove loading message
        removeMessage(loadingId);
        
        // Add error message
        addMessage(`Error: ${error.message}`, 'assistant', false, true);
    } finally {
        sendBtn.disabled = false;
        messageInput.focus();
    }
}

async function queryAgent(agent, question) {
    const endpoint = API_ENDPOINTS[agent];
    
    // Prepare conversation history (only relevant parts) for SQL-of-Thought agents
    const historyForAgent = conversationHistory
        .filter(turn => turn.agent === agent)
        .map(turn => ({ 
            question: turn.question, 
            sql: turn.sql,
            tables: turn.tables,
            rowCount: turn.rowCount,
            keyMetric: turn.keyMetric
        }));

    if (agent === 'sql-of-thought-summary') {
        console.log('[DEBUG] Sending history to Summary API:', historyForAgent.length, 'turns');
        
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ 
                question,
                conversation_history: historyForAgent
            })
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        return await response.json();
    } else if (agent === 'sql-of-thought-embeddings') {
        console.log('[DEBUG] Sending to Embeddings API:', historyForAgent.length, 'previous turns');
        
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ 
                question,
                conversation_id: 'default' // Could be session-specific in production
            })
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        return await response.json();
    } else if (agent === 'docking-agent') {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ 
                question
            })
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        return await response.json();
    }
}

function formatResponse(response, agent) {
    if (agent === 'sql-of-thought-summary' || agent === 'sql-of-thought-embeddings') {
        let html = '';
        
        // Show final answer from orchestrator if available
        if (response.finalAnswer) {
            html += `<div class="final-answer">
                <strong>💡 Answer:</strong>
                <p>${escapeHtml(response.finalAnswer)}</p>
            </div>`;
        }
        
        if (response.sql) {
            html += `<div class="sql-query">
                <strong>Generated SQL:</strong>
                <pre><code>${escapeHtml(response.sql)}</code></pre>
            </div>`;
        }
        
        if (response.results && response.results.length > 0) {
            html += `<div class="results">
                <strong>Results (${response.row_count} rows):</strong>
                ${formatTable(response.results)}
            </div>`;
        } else if (response.success && response.row_count === 0) {
            html += '<p>Query executed successfully but returned no results.</p>';
        }
        
        // Display visualization if generated
        if (response.visualization) {
            const viz = response.visualization;
            // Get the API server base URL for this agent
            const apiBaseUrl = agent === 'sql-of-thought-summary' 
                ? 'http://localhost:8000' 
                : 'http://localhost:8001';
            // The plot_file_path is like "plots/filename.png", so we can use it directly
            const plotUrl = `${apiBaseUrl}/${viz.plot_file_path}`;
            
            html += `<div class="visualization">
                <strong>📊 Visualization:</strong>
                <p><em>${escapeHtml(viz.plot_description || 'Chart generated')}</em></p>
                <img src="${plotUrl}" alt="${escapeHtml(viz.plot_description || 'Chart')}" style="max-width: 100%; height: auto; margin-top: 10px; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);" onerror="this.style.display='none'; this.nextElementSibling.style.display='block';">
                <p style="display:none; color: #888;">⚠️ Visualization image could not be loaded</p>
            </div>`;
        }
        
        // Display conversation summary (if active)
        if (response.summary) {
            const summary = response.summary;
            console.log('[DEBUG] Summary object:', JSON.stringify(summary).substring(0, 200));
            
            html += '<div class="context-summary">';
            html += '<strong>📚 Context Summary Active</strong>';
            html += '<div class="summary-info">';
            html += `<span>Compressing ${summary.turnsCount || 0} previous turns into ${summary.tokenCount || 0} tokens</span>`;
            html += `<span>Tables referenced: ${(summary.tablesUsed || []).join(', ') || 'none'}</span>`;
            html += '</div>';
            html += '<details class="summary-details" open>';
            html += '<summary>View Summary Text</summary>';
            
            const summaryText = summary.summaryText || '[No summary text generated]';
            console.log('[DEBUG] Summary text:', summaryText);
            
            html += `<div class="summary-text">${escapeHtml(summaryText)}</div>`;
            html += '</details>';
            html += '</div>';
        }

        // Display token usage
        if (response.tokenUsage) {
            const tokenUsage = response.tokenUsage;
            const aggregate = tokenUsage.aggregate;
            
            // Update session tokens
            sessionTokens[agent].totalPromptTokens += aggregate.totalPromptTokens;
            sessionTokens[agent].totalCompletionTokens += aggregate.totalCompletionTokens;
            sessionTokens[agent].totalTokens += aggregate.totalTokens;
            
            html += '<div class="token-usage">';
            html += '<strong>🎯 Token Usage</strong>';
            html += '<div class="token-summary">';
            html += `<span>Model: <code>${tokenUsage.model}</code></span>`;
            html += `<span>Total: <strong>${aggregate.totalTokens}</strong> tokens (${aggregate.totalPromptTokens} in / ${aggregate.totalCompletionTokens} out)</span>`;
            html += `<span>Session Total: <strong>${sessionTokens[agent].totalTokens}</strong> tokens</span>`;
            html += '</div>';
            
            // Per-agent breakdown (expandable)
            html += '<details class="token-details">';
            html += '<summary>Show Per-Agent Breakdown</summary>';
            html += '<table class="token-table">';
            html += '<tr><th>Tool/Agent</th><th>Prompt Tokens</th><th>Completion Tokens</th><th>Total</th></tr>';
            tokenUsage.perAgent.forEach(agentUsage => {
                // Handle both formats: orchestrator uses 'tool', old APIs use 'agent'
                const name = (agentUsage.tool || agentUsage.agent || 'unknown').replace(/_/g, ' ');
                html += `<tr>`;
                html += `<td>${name}</td>`;
                html += `<td>${agentUsage.promptTokens}</td>`;
                html += `<td>${agentUsage.completionTokens}</td>`;
                html += `<td><strong>${agentUsage.totalTokens}</strong></td>`;
                html += `</tr>`;
            });
            html += '</table>';
            html += '</details>';
            html += '</div>';
        }
        
        // Display orchestrator iterations if available
        if (response.iterations !== undefined) {
            html += `<p class="metadata"><em>🔄 Orchestrator iterations: ${response.iterations}</em></p>`;
        }
        
        // Display detailed timing breakdown
        if (response.timings) {
            html += '<div class="timing-breakdown">';
            html += '<strong>Pipeline Timing:</strong>';
            html += '<table class="timing-table">';
            
            if (response.timings.schema_loading_ms !== undefined) {
                html += `<tr><td>Schema Loading:</td><td>${response.timings.schema_loading_ms}ms</td></tr>`;
            }
            if (response.timings.schema_linking_ms !== undefined) {
                html += `<tr><td>Schema Linking Agent:</td><td>${response.timings.schema_linking_ms}ms</td></tr>`;
            }
            if (response.timings.subproblem_ms !== undefined) {
                html += `<tr><td>Subproblem Agent:</td><td>${response.timings.subproblem_ms}ms</td></tr>`;
            }
            if (response.timings.query_plan_ms !== undefined) {
                html += `<tr><td>Query Plan Agent:</td><td>${response.timings.query_plan_ms}ms</td></tr>`;
            }
            if (response.timings.sql_generation_ms !== undefined) {
                html += `<tr><td>SQL Generation Agent:</td><td>${response.timings.sql_generation_ms}ms</td></tr>`;
            }
            if (response.timings.sql_execution_ms !== undefined) {
                html += `<tr><td>SQL Execution:</td><td>${response.timings.sql_execution_ms}ms</td></tr>`;
            }
            if (response.timings.correction_attempts_ms) {
                response.timings.correction_attempts_ms.forEach((time, i) => {
                    html += `<tr><td>Correction Attempt ${i+1}:</td><td>${time}ms</td></tr>`;
                });
            }
            
            if (response.timings.total_pipeline_ms !== undefined) {
                html += `<tr class="timing-total"><td><strong>Total:</strong></td><td><strong>${response.timings.total_pipeline_ms}ms</strong></td></tr>`;
            } else if (response.timings.total_ms !== undefined) {
                html += `<tr class="timing-total"><td><strong>Total:</strong></td><td><strong>${response.timings.total_ms}ms</strong></td></tr>`;
            }
            
            html += '</table>';
            html += '</div>';
        } else if (response.execution_time_ms) {
            html += `<p class="metadata"><em>Execution time: ${response.execution_time_ms}ms</em></p>`;
        }
        
        return html || '<p>No response data available.</p>';
    } else if (agent === 'docking-agent') {
        let html = '';
        
        if (response.answer !== null && response.answer !== undefined) {
            if (typeof response.answer === 'object') {
                if (Array.isArray(response.answer)) {
                    if (response.answer.length > 0) {
                        html += `<strong>Results:</strong>`;
                        html += formatTable(response.answer);
                    } else {
                        html += '<p>No results found.</p>';
                    }
                } else {
                    html += `<strong>Result:</strong>`;
                    html += `<pre><code>${JSON.stringify(response.answer, null, 2)}</code></pre>`;
                }
            } else {
                html += `<p><strong>Answer:</strong> ${escapeHtml(String(response.answer))}</p>`;
            }
        }
        
        if (response.explanation) {
            html += `<p><em>${escapeHtml(response.explanation)}</em></p>`;
        }
        
        // Display token usage for docking agent
        if (response.tokenUsage) {
            const tokenUsage = response.tokenUsage;
            
            // Update session tokens
            sessionTokens[agent].totalPromptTokens += tokenUsage.promptTokens;
            sessionTokens[agent].totalCompletionTokens += tokenUsage.completionTokens;
            sessionTokens[agent].totalTokens += tokenUsage.totalTokens;
            
            html += '<div class="token-usage">';
            html += '<strong>🎯 Token Usage</strong>';
            html += '<div class="token-summary">';
            html += `<span>Model: <code>${tokenUsage.model}</code> (${tokenUsage.provider})</span>`;
            html += `<span>Total: <strong>${tokenUsage.totalTokens}</strong> tokens (${tokenUsage.promptTokens} in / ${tokenUsage.completionTokens} out)</span>`;
            html += `<span>Session Total: <strong>${sessionTokens[agent].totalTokens}</strong> tokens</span>`;
            html += '</div>';
            html += '</div>';
        }
        
        if (response.router) {
            html += `<p class="metadata"><em>Source: ${response.router.source}, Confidence: ${(response.router.confidence * 100).toFixed(0)}%</em></p>`;
        }
        
        return html || '<p>No response available.</p>';
    }
}

function formatTable(data) {
    if (!data || data.length === 0) return '';
    
    const keys = Object.keys(data[0]);
    let html = '<table>';
    
    // Header
    html += '<tr>';
    keys.forEach(key => {
        html += `<th>${escapeHtml(key)}</th>`;
    });
    html += '</tr>';
    
    // Rows (limit to first 10 for display)
    data.slice(0, 10).forEach(row => {
        html += '<tr>';
        keys.forEach(key => {
            const value = row[key];
            html += `<td>${escapeHtml(String(value))}</td>`;
        });
        html += '</tr>';
    });
    
    if (data.length > 10) {
        html += `<tr><td colspan="${keys.length}"><em>... and ${data.length - 10} more rows</em></td></tr>`;
    }
    
    html += '</table>';
    return html;
}

function addMessage(content, role, isLoading = false, isError = false) {
    const messageId = 'msg-' + Date.now();
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${role}-message`;
    messageDiv.id = messageId;
    
    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';
    avatar.textContent = role === 'user' ? 'U' : 'A';
    
    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';
    
    if (isLoading) {
        contentDiv.innerHTML = '<div class="loading-indicator"><span></span><span></span><span></span></div>';
    } else if (isError) {
        contentDiv.innerHTML = `<p style="color: #ff6b6b;">${escapeHtml(content)}</p>`;
    } else {
        contentDiv.innerHTML = content;
    }
    
    messageDiv.appendChild(avatar);
    messageDiv.appendChild(contentDiv);
    
    messagesContainer.appendChild(messageDiv);
    
    // Scroll to bottom
    messagesContainer.parentElement.scrollTop = messagesContainer.parentElement.scrollHeight;
    
    return messageId;
}

function removeMessage(messageId) {
    const message = document.getElementById(messageId);
    if (message) {
        message.remove();
    }
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Initialize
updateAgentLabel();

