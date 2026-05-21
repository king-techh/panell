const axios = require('axios');
const config = require('./config');

class PterodactylAPI {
  constructor() {
    this.client = axios.create({
      baseURL: `${config.PTERO.url}/api`,
      headers: {
        Authorization: `Bearer ${config.PTERO.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'Application/vnd.pterodactyl.v1+json',
      },
      timeout: 30000,
    });

    // Cache egg details to avoid repeated API calls
    this._eggCache = new Map();
  }

  // ─── Auto-Discover Panel Resources ────────────────────
  // Queries the panel to find nest, egg, node IDs.
  // Returns: { nodeId, nestId, eggId, eggDetails }

  async autoDiscover() {
    console.log('[Discovery] Auto-discovering panel resources...');

    let nodeId = null;
    let nestId = null;
    let eggDetails = null;

    // 1. Find a node
    try {
      const nodesRes = await this.client.get('/application/nodes');
      const nodes = nodesRes.data.data.map(n => n.attributes);
      if (nodes.length > 0) {
        nodeId = nodes[0].id;
        console.log(`[Discovery] Found node: ID=${nodeId}, name="${nodes[0].name}"`);
      }
    } catch (err) {
      if (err.response && err.response.status === 401) {
        console.error('[Discovery] API TOKEN INVALID — Please update PTERO_API_KEY in .env');
        return { nodeId: null, nestId: null, eggId: null, eggDetails: null };
      }
      console.warn(`[Discovery] Failed to list nodes: ${err.message}`);
    }

    // 2. Find the egg (search for "killer", "node.js", or "generic")
    try {
      const nestsRes = await this.client.get('/application/nests');
      const nests = nestsRes.data.data.map(n => n.attributes);

      // First pass: look for "killer" nest or egg
      for (const nest of nests) {
        try {
          const eggsRes = await this.client.get(`/application/nests/${nest.id}/eggs`, {
            params: { include: 'variables' },
          });
          const eggs = eggsRes.data.data.map(e => e.attributes);

          for (const egg of eggs) {
            const eggName = (egg.name || '').toLowerCase();
            const nestName = (nest.name || '').toLowerCase();
            console.log(`[Discovery] Found egg: nest=${nest.id} ("${nest.name}"), egg=${egg.id}, name="${egg.name}"`);

            if (eggName.includes('killer') || nestName.includes('killer')) {
              nestId = nest.id;
              eggDetails = egg;
              console.log(`[Discovery] Matched "killer" egg: nest=${nest.id}, egg=${egg.id}`);
              break;
            }
          }
          if (eggDetails) break;
        } catch (e) {
          console.warn(`[Discovery] Failed to list eggs for nest ${nest.id}: ${e.message}`);
        }
      }

      // Second pass: look for node.js/generic egg
      if (!eggDetails) {
        for (const nest of nests) {
          try {
            const eggsRes = await this.client.get(`/application/nests/${nest.id}/eggs`, {
              params: { include: 'variables' },
            });
            const eggs = eggsRes.data.data.map(e => e.attributes);

            for (const egg of eggs) {
              const eggName = (egg.name || '').toLowerCase();
              if (eggName.includes('node') || eggName.includes('nodejs') || eggName.includes('generic')) {
                nestId = nest.id;
                eggDetails = egg;
                console.log(`[Discovery] Found Node.js egg: nest=${nest.id}, egg=${egg.id}`);
                break;
              }
            }
            if (eggDetails) break;
          } catch (e) {}
        }
      }

      // Third pass: use first egg found
      if (!eggDetails) {
        for (const nest of nests) {
          try {
            const eggsRes = await this.client.get(`/application/nests/${nest.id}/eggs`, {
              params: { include: 'variables' },
            });
            const eggs = eggsRes.data.data.map(e => e.attributes);
            if (eggs.length > 0) {
              nestId = nest.id;
              eggDetails = eggs[0];
              console.log(`[Discovery] Using first egg: nest=${nest.id}, egg=${eggs[0].id}`);
              break;
            }
          } catch (e) {}
        }
      }
    } catch (err) {
      console.warn(`[Discovery] Failed to discover eggs: ${err.message}`);
    }

    // Log discovery results
    console.log(`[Discovery] Results:`);
    console.log(`  Node ID: ${nodeId || 'NOT FOUND'}`);
    console.log(`  Nest ID: ${nestId || 'NOT FOUND'}`);
    console.log(`  Egg: ${eggDetails ? `ID=${eggDetails.id}, name="${eggDetails.name}"` : 'NOT FOUND'}`);
    if (eggDetails) {
      console.log(`  Docker: ${eggDetails.docker_image || 'N/A'}`);
      if (eggDetails.relationships && eggDetails.relationships.variables) {
        const vars = eggDetails.relationships.variables.data;
        console.log(`  Egg Variables (${vars.length}):`);
        for (const v of vars) {
          const a = v.attributes;
          console.log(`    ${a.env_variable} = "${a.default_value}" (rules: ${a.rules})`);
        }
      }
    }

    // Cache egg details
    if (eggDetails && nestId) {
      this._eggCache.set(`${nestId}_${eggDetails.id}`, eggDetails);
    }

    return { nodeId, nestId, eggId: eggDetails ? eggDetails.id : null, eggDetails };
  }

  // ─── User Management ──────────────────────────────────

  async createUser(username, email, password, firstName, lastName, rootAdmin = false) {
    try {
      const response = await this.client.post('/application/users', {
        username,
        email,
        password,
        first_name: firstName,
        last_name: lastName,
        root_admin: rootAdmin,
        language: 'en',
      });
      return response.data.attributes;
    } catch (err) {
      // If user already exists, try to find them and update
      if (err.response && err.response.status === 422) {
        console.log(`[Ptero] User ${username} already exists, searching...`);
        const existingUser = await this.findUserByEmail(email);
        if (existingUser) {
          if (rootAdmin && !existingUser.root_admin) {
            try {
              const updateRes = await this.client.patch(`/application/users/${existingUser.id}`, {
                root_admin: true,
              });
              return updateRes.data.attributes;
            } catch (updateErr) {
              console.warn(`[Ptero] Could not update user to admin: ${updateErr.message}`);
            }
          }
          return existingUser;
        }
      }
      throw this._handleError(err, 'createUser');
    }
  }

  async findUserByEmail(email) {
    try {
      const response = await this.client.get('/application/users', {
        params: { 'filter[email]': email },
      });
      const users = response.data.data;
      if (users.length > 0) return users[0].attributes;
      return null;
    } catch (err) {
      throw this._handleError(err, 'findUserByEmail');
    }
  }

  async findUserByUsername(username) {
    try {
      const response = await this.client.get('/application/users', {
        params: { 'filter[username]': username },
      });
      const users = response.data.data;
      if (users.length > 0) return users[0].attributes;
      return null;
    } catch (err) {
      throw this._handleError(err, 'findUserByUsername');
    }
  }

  async getUser(userId) {
    try {
      const response = await this.client.get(`/application/users/${userId}`);
      return response.data.attributes;
    } catch (err) {
      throw this._handleError(err, 'getUser');
    }
  }

  async deleteUser(userId) {
    try {
      await this.client.delete(`/application/users/${userId}`);
      console.log(`[Ptero] Deleted user ID=${userId} from panel`);
      return true;
    } catch (err) {
      console.warn(`[Ptero] Failed to delete user ID=${userId}: ${err.message}`);
      return false;
    }
  }

  // ─── Server Management ────────────────────────────────

  async createServer({ name, userId, memory, disk, cpu, eggId, nestId, dockerImage, startupCmd, environment }) {
    try {
      // Use config defaults for IDs
      const useNestId = nestId || config.PTERO.nestId;
      const useEggId = eggId || config.PTERO.eggId;
      const useNodeId = config.PTERO.nodeId;

      // ─── CRITICAL: Always fetch a FRESH allocation ──────
      // Never use cached allocations — they get used up!
      console.log(`[Server] Finding fresh allocation for server "${name}"...`);
      const defaultAllocation = await this.findAvailableAllocation(useNodeId);

      if (!defaultAllocation) {
        throw new Error('No available server allocations found. Contact admin to add more ports to the panel.');
      }

      console.log(`[Server] Fresh allocation found: ID=${defaultAllocation}`);

      // ─── ALWAYS fetch egg details fresh ──────────────
      // Never use cache for server creation — egg config might change
      let eggDetails = null;
      try {
        eggDetails = await this.getEggDetails(useNestId, useEggId);
        console.log(`[Server] Fetched egg details: name="${eggDetails.name}"`);
        console.log(`[Server] Egg startup: ${eggDetails.startup}`);
        console.log(`[Server] Egg docker: ${eggDetails.docker_image}`);
      } catch (err) {
        console.warn(`[Server] Could not fetch egg details: ${err.message}`);
        // Fall back to cache if available
        const cacheKey = `${useNestId}_${useEggId}`;
        if (this._eggCache.has(cacheKey)) {
          eggDetails = this._eggCache.get(cacheKey);
          console.log(`[Server] Using cached egg details`);
        }
      }

      // Build environment from egg variable defaults
      let envVars = {};

      if (eggDetails && eggDetails.relationships && eggDetails.relationships.variables) {
        const eggVars = eggDetails.relationships.variables.data;
        console.log(`[Server] Egg has ${eggVars.length} variables — using their defaults:`);

        for (const v of eggVars) {
          const attr = v.attributes;
          const envName = attr.env_variable;
          const defaultVal = attr.default_value ?? '';
          envVars[envName] = String(defaultVal);
          console.log(`  ${envName} = "${defaultVal}" (rules: ${attr.rules})`);
        }
      }

      // Fallback: known node.js generic egg variables (egg 15 in nest 5)
      if (Object.keys(envVars).length === 0) {
        console.log(`[Server] Using node.js generic egg fallback env vars`);
        envVars = {
          GIT_ADDRESS: '',
          BRANCH: '',
          USER_UPLOAD: '0',
          AUTO_UPDATE: '0',
          NODE_PACKAGES: '',
          USERNAME: '',
          ACCESS_TOKEN: '',
          UNNODE_PACKAGES: '',
          MAIN_FILE: 'index.js',
          NODE_ARGS: '',
        };
      }

      // Force USER_UPLOAD=1 (users upload their own files)
      if (envVars.hasOwnProperty('USER_UPLOAD')) {
        envVars.USER_UPLOAD = '1';
      }
      // Ensure MAIN_FILE is set
      if (envVars.hasOwnProperty('MAIN_FILE') && (!envVars.MAIN_FILE || envVars.MAIN_FILE === '')) {
        envVars.MAIN_FILE = 'index.js';
      }
      // Clear git-related fields
      if (envVars.hasOwnProperty('GIT_ADDRESS')) envVars.GIT_ADDRESS = '';
      if (envVars.hasOwnProperty('BRANCH')) envVars.BRANCH = '';
      if (envVars.hasOwnProperty('AUTO_UPDATE')) envVars.AUTO_UPDATE = '0';

      // Override with user-provided environment (if any)
      if (environment) {
        envVars = { ...envVars, ...environment };
      }

      // ─── IMPORTANT: Always use startup command from egg ──────
      // The egg's startup command contains {{VARIABLE}} placeholders
      // that Pterodactyl replaces with the actual env var values.
      // NEVER override with a custom startup command unless explicitly provided.
      const useStartupCmd = startupCmd ||
        (eggDetails && eggDetails.startup) ||
        config.PTERO.startupCmd;

      // Get docker image from egg if available
      const useDockerImage = dockerImage ||
        (eggDetails && eggDetails.docker_image) ||
        config.PTERO.dockerImage;

      // ─── Build the server creation payload ──────────────
      // IMPORTANT: The Pterodactyl API requires `allocation.default`
      // to be an INTEGER matching an unassigned allocation ID on the node.
      const serverData = {
        name,
        user: userId,
        nest: useNestId,
        egg: useEggId,
        docker_image: useDockerImage,
        startup: useStartupCmd,
        environment: envVars,
        limits: {
          memory: memory,
          swap: 0,
          disk: disk,
          io: 500,
          cpu: cpu,
        },
        feature_limits: {
          databases: 2,
          backups: 1,
          allocations: 0,
        },
        allocation: {
          default: Number(defaultAllocation),  // MUST be an integer
        },
        start_on_completion: true,
      };

      console.log(`[Server] Creating "${name}" | Egg: ${useEggId} | Nest: ${useNestId} | Node: ${useNodeId} | Alloc: ${defaultAllocation}`);
      console.log(`[Server] Docker: ${useDockerImage}`);
      console.log(`[Server] Startup: ${useStartupCmd.substring(0, 100)}...`);
      console.log(`[Server] Environment: ${JSON.stringify(envVars)}`);
      console.log(`[Server] Allocation.default type: ${typeof serverData.allocation.default} value: ${serverData.allocation.default}`);

      const response = await this.client.post('/application/servers', serverData);
      console.log(`[Server] Server created successfully! ID=${response.data.attributes.id}`);
      return response.data.attributes;
    } catch (err) {
      // Enhanced error logging for debugging
      if (err.response) {
        const errorData = err.response.data;
        console.error(`[Server] Creation failed (${err.response.status}):`);
        if (errorData && errorData.errors) {
          errorData.errors.forEach(e => {
            console.error(`  - ${e.code}: ${e.detail}`);
            if (e.meta) console.error(`    Meta: ${JSON.stringify(e.meta)}`);
          });
        } else {
          console.error(`  Raw: ${JSON.stringify(errorData).substring(0, 500)}`);
        }
      }
      throw this._handleError(err, 'createServer');
    }
  }

  async getServer(serverId) {
    try {
      const response = await this.client.get(`/application/servers/${serverId}`);
      return response.data.attributes;
    } catch (err) {
      throw this._handleError(err, 'getServer');
    }
  }

  async getUserServers(userId) {
    try {
      const response = await this.client.get('/application/servers', {
        params: { 'filter[user_id]': userId },
      });
      return response.data.data.map((s) => s.attributes);
    } catch (err) {
      throw this._handleError(err, 'getUserServers');
    }
  }

  async deleteServer(serverId) {
    try {
      await this.client.delete(`/application/servers/${serverId}`, {
        params: { force: true },
      });
      return true;
    } catch (err) {
      throw this._handleError(err, 'deleteServer');
    }
  }

  async suspendServer(serverId) {
    try {
      await this.client.post(`/application/servers/${serverId}/suspend`);
      return true;
    } catch (err) {
      throw this._handleError(err, 'suspendServer');
    }
  }

  async unsuspendServer(serverId) {
    try {
      await this.client.post(`/application/servers/${serverId}/unsuspend`);
      return true;
    } catch (err) {
      throw this._handleError(err, 'unsuspendServer');
    }
  }

  // ─── Resource Discovery ───────────────────────────────

  async findAvailableAllocation(nodeId) {
    try {
      const useNodeId = nodeId || config.PTERO.nodeId;
      console.log(`[Allocation] Searching for free allocation on node ${useNodeId}...`);

      // Method 1: Use filter[server_id] for unassigned allocations
      // This is more reliable than checking the `assigned` field manually
      try {
        const filterResponse = await this.client.get(`/application/nodes/${useNodeId}/allocations`, {
          params: {
            'filter[server_id]': '',
            per_page: 100,
          },
        });

        const filteredAllocs = filterResponse.data.data;
        if (filteredAllocs && filteredAllocs.length > 0) {
          // These allocations have no server assigned — they are free
          const freeAlloc = filteredAllocs.find(a => !a.attributes.assigned);
          if (freeAlloc) {
            console.log(`[Allocation] Found free (filtered): ID=${freeAlloc.attributes.id}, port=${freeAlloc.attributes.port}`);
            return Number(freeAlloc.attributes.id);
          }
        }
      } catch (filterErr) {
        console.warn(`[Allocation] Filter method failed, using fallback: ${filterErr.message}`);
      }

      // Method 2: Fallback — get all allocations and find unassigned
      const response = await this.client.get(`/application/nodes/${useNodeId}/allocations`, {
        params: { per_page: 100 },
      });

      const allocations = response.data.data;
      const available = allocations.find((a) => !a.attributes.assigned);

      if (available) {
        console.log(`[Allocation] Found available: ID=${available.attributes.id}, port=${available.attributes.port}`);
        return Number(available.attributes.id);
      }

      // Try with pagination
      if (response.data.meta && response.data.meta.pagination) {
        const totalPages = response.data.meta.pagination.total_pages;
        for (let page = 2; page <= totalPages; page++) {
          const pageResponse = await this.client.get(
            `/application/nodes/${useNodeId}/allocations`,
            { params: { per_page: 100, page } }
          );
          const pageAllocs = pageResponse.data.data;
          const avail = pageAllocs.find((a) => !a.attributes.assigned);
          if (avail) {
            console.log(`[Allocation] Found available (page ${page}): ID=${avail.attributes.id}, port=${avail.attributes.port}`);
            return Number(avail.attributes.id);
          }
        }
      }

      console.warn('[Allocation] No available allocations found on node', useNodeId);
      return null;
    } catch (err) {
      console.error('[Ptero] Failed to find allocation:', err.message);
      if (err.response) {
        console.error('[Ptero] Allocation API error:', JSON.stringify(err.response.data));
      }
      return null;
    }
  }

  async getNodes() {
    try {
      const response = await this.client.get('/application/nodes');
      return response.data.data.map((n) => n.attributes);
    } catch (err) {
      throw this._handleError(err, 'getNodes');
    }
  }

  async getNests() {
    try {
      const response = await this.client.get('/application/nests');
      return response.data.data.map((n) => n.attributes);
    } catch (err) {
      throw this._handleError(err, 'getNests');
    }
  }

  async getEggs(nestId) {
    try {
      const response = await this.client.get(`/application/nests/${nestId}/eggs`);
      return response.data.data.map((e) => e.attributes);
    } catch (err) {
      throw this._handleError(err, 'getEggs');
    }
  }

  async getEggDetails(nestId, eggId) {
    const cacheKey = `${nestId}_${eggId}`;
    if (this._eggCache.has(cacheKey)) {
      return this._eggCache.get(cacheKey);
    }

    try {
      const response = await this.client.get(
        `/application/nests/${nestId}/eggs/${eggId}`,
        { params: { include: 'variables' } }
      );
      const data = response.data.attributes;
      this._eggCache.set(cacheKey, data);
      return data;
    } catch (err) {
      throw this._handleError(err, 'getEggDetails');
    }
  }

  // Clear egg cache (useful after token change)
  clearEggCache() {
    this._eggCache.clear();
    console.log('[PterodactylAPI] Egg cache cleared');
  }

  async getLocations() {
    try {
      const response = await this.client.get('/application/locations');
      return response.data.data.map((l) => l.attributes);
    } catch (err) {
      throw this._handleError(err, 'getLocations');
    }
  }

  // ─── Setup Helper ─────────────────────────────────────

  async getSetupInfo() {
    try {
      const [nodes, nests, locations] = await Promise.all([
        this.getNodes(),
        this.getNests(),
        this.getLocations(),
      ]);

      let eggsInfo = [];
      for (const nest of nests) {
        try {
          const eggs = await this.getEggs(nest.id);
          eggsInfo.push({ nest, eggs });
        } catch (e) {
          eggsInfo.push({ nest, eggs: [], error: e.message });
        }
      }

      return { nodes, nests: eggsInfo, locations };
    } catch (err) {
      throw this._handleError(err, 'getSetupInfo');
    }
  }

  // ─── Error Handling ───────────────────────────────────

  _handleError(err, method) {
    if (err.response) {
      const { status, data } = err.response;
      const errors = data?.errors || [];
      const message = errors.map(e => e.detail).join('; ') || data?.error || JSON.stringify(data);
      console.error(`[PterodactylAPI] ${method} failed (${status}): ${message}`);
      return new Error(`Panel error: ${message}`);
    }
    console.error(`[PterodactylAPI] ${method} failed:`, err.message);
    return err;
  }
}

module.exports = new PterodactylAPI();
