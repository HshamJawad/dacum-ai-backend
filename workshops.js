const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireFacilitatorAuth } = require('../middleware/auth');
const { workshopSchema, snapshotSchema } = require('../validators/schemas');
const { generateWorkshopCode, generateToken } = require('../utils/helpers');

// Create workshop
router.post('/', async (req, res) => {
  try {
    const validated = workshopSchema.parse(req.body);
    
    const workshopCode = generateWorkshopCode();
    const facilitatorToken = generateToken('FTOKEN');
    
    const result = await db.query(
      `INSERT INTO workshops (
        workshop_code, 
        title, 
        facilitator_token, 
        status, 
        workflow_type, 
        priority_formula, 
        expires_at
      ) VALUES ($1, $2, $3, 'active', $4, $5, NOW() + INTERVAL '${validated.expiryHours || 48} hours')
      RETURNING *`,
      [workshopCode, validated.title, facilitatorToken, validated.workflowType || 'standard', validated.priorityFormula || 'if']
    );
    
    const workshop = result.rows[0];
    
    res.status(201).json({
      success: true,
      message: 'Workshop created successfully',
      workshop: {
        id: workshop.id,
        workshopCode: workshop.workshop_code,
        title: workshop.title,
        status: workshop.status,
        workflowType: workshop.workflow_type,
        priorityFormula: workshop.priority_formula,
        createdAt: workshop.created_at,
        expiresAt: workshop.expires_at
      },
      facilitatorToken: facilitatorToken
    });
    
  } catch (error) {
    console.error('Create workshop error:', error);
    res.status(400).json({ error: 'Failed to create workshop' });
  }
});

// Get my workshop
router.get('/my', requireFacilitatorAuth, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM workshops WHERE facilitator_token = $1',
      [req.facilitatorToken]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Workshop not found' });
    }
    
    const workshop = result.rows[0];
    
    res.json({
      success: true,
      workshop: {
        id: workshop.id,
        workshopCode: workshop.workshop_code,
        title: workshop.title,
        status: workshop.status,
        workflowType: workshop.workflow_type,
        priorityFormula: workshop.priority_formula,
        createdAt: workshop.created_at,
        expiresAt: workshop.expires_at
      }
    });
    
  } catch (error) {
    console.error('Get workshop error:', error);
    res.status(500).json({ error: 'Failed to get workshop' });
  }
});

// Upload DACUM snapshot
// CRITICAL: Backend generates taskKey here
router.post('/:workshopCode/snapshot', requireFacilitatorAuth, async (req, res) => {
  const { workshopCode } = req.params;
  const { duties } = req.body;
  
  try {
    // Validate request
    const validated = snapshotSchema.parse({ duties });
    
    // Validate workshop exists and is owned by facilitator
    const workshop = await db.query(
      'SELECT id FROM workshops WHERE workshop_code = $1 AND facilitator_token = $2',
      [workshopCode, req.facilitatorToken]
    );
    
    if (workshop.rows.length === 0) {
      return res.status(404).json({ error: 'Workshop not found or unauthorized' });
    }
    
    const workshopId = workshop.rows[0].id;
    
    // Begin transaction
    await db.query('BEGIN');
    
    try {
      // Delete old duties/tasks if re-uploading
      await db.query('DELETE FROM duties WHERE workshop_id = $1', [workshopId]);
      
      // Insert duties and tasks, generating taskKey
      for (const duty of validated.duties) {
        // Insert duty
        const dutyResult = await db.query(
          `INSERT INTO duties (workshop_id, duty_id, title, sort_order) 
           VALUES ($1, $2, $3, $4) 
           RETURNING id`,
          [workshopId, duty.dutyId, duty.dutyTitle, duty.sortOrder || 0]
        );
        
        const dutyDbId = dutyResult.rows[0].id;
        
        // Insert tasks with BACKEND-GENERATED taskKey
        if (duty.tasks && duty.tasks.length > 0) {
          for (let i = 0; i < duty.tasks.length; i++) {
            const task = duty.tasks[i];
            
            // CRITICAL: Generate taskKey here (backend-owned)
            // Format: {workshopCode}_{dutyId}_{taskIndex}
            const taskKey = `${workshopCode}_${duty.dutyId}_${i + 1}`;
            
            await db.query(
              `INSERT INTO tasks (duty_id, task_key, title, sort_order) 
               VALUES ($1, $2, $3, $4)`,
              [dutyDbId, taskKey, task.taskTitle, task.sortOrder || (i + 1)]
            );
          }
        }
      }
      
      await db.query('COMMIT');
      
      // Fetch complete snapshot to return (with generated taskKeys)
      const snapshotResult = await db.query(`
        SELECT 
          d.duty_id,
          d.title AS duty_title,
          d.sort_order,
          COALESCE(
            json_agg(
              json_build_object(
                'taskKey', t.task_key,
                'taskTitle', t.title,
                'sortOrder', t.sort_order
              ) ORDER BY t.sort_order
            ) FILTER (WHERE t.task_key IS NOT NULL),
            '[]'
          ) AS tasks
        FROM duties d
        LEFT JOIN tasks t ON t.duty_id = d.id
        WHERE d.workshop_id = $1
        GROUP BY d.id, d.duty_id, d.title, d.sort_order
        ORDER BY d.sort_order
      `, [workshopId]);
      
      const snapshot = {
        duties: snapshotResult.rows.map(row => ({
          dutyId: row.duty_id,
          dutyTitle: row.duty_title,
          sortOrder: row.sort_order,
          tasks: row.tasks
        }))
      };
      
      res.json({
        success: true,
        message: 'Snapshot uploaded successfully',
        snapshot: snapshot
      });
      
    } catch (err) {
      await db.query('ROLLBACK');
      throw err;
    }
    
  } catch (error) {
    console.error('Snapshot upload error:', error);
    if (error.name === 'ZodError') {
      return res.status(400).json({ 
        error: 'Validation failed', 
        details: error.errors 
      });
    }
    res.status(500).json({ error: 'Failed to upload snapshot' });
  }
});

// Get DACUM snapshot (public endpoint)
router.get('/:workshopCode/snapshot', async (req, res) => {
  const { workshopCode } = req.params;
  
  try {
    // Get workshop
    const workshop = await db.query(
      'SELECT id, title, status, workflow_type, priority_formula FROM workshops WHERE workshop_code = $1',
      [workshopCode]
    );
    
    if (workshop.rows.length === 0) {
      return res.status(404).json({ error: 'Workshop not found' });
    }
    
    const workshopData = workshop.rows[0];
    
    // Get snapshot with taskKeys
    const snapshotResult = await db.query(`
      SELECT 
        d.duty_id,
        d.title AS duty_title,
        d.sort_order,
        COALESCE(
          json_agg(
            json_build_object(
              'taskKey', t.task_key,
              'taskTitle', t.title,
              'sortOrder', t.sort_order
            ) ORDER BY t.sort_order
          ) FILTER (WHERE t.task_key IS NOT NULL),
          '[]'
        ) AS tasks
      FROM duties d
      LEFT JOIN tasks t ON t.duty_id = d.id
      WHERE d.workshop_id = $1
      GROUP BY d.id, d.duty_id, d.title, d.sort_order
      ORDER BY d.sort_order
    `, [workshopData.id]);
    
    const snapshot = {
      duties: snapshotResult.rows.map(row => ({
        dutyId: row.duty_id,
        dutyTitle: row.duty_title,
        sortOrder: row.sort_order,
        tasks: row.tasks
      }))
    };
    
    res.json({
      success: true,
      workshop: {
        workshopCode: workshopCode,
        title: workshopData.title,
        status: workshopData.status,
        workflowType: workshopData.workflow_type,
        priorityFormula: workshopData.priority_formula
      },
      snapshot: snapshot
    });
    
  } catch (error) {
    console.error('Get snapshot error:', error);
    res.status(500).json({ error: 'Failed to get snapshot' });
  }
});

// Update workshop status
router.patch('/my', requireFacilitatorAuth, async (req, res) => {
  const { status, title } = req.body;
  
  try {
    const updates = [];
    const values = [];
    let paramCount = 1;
    
    if (title !== undefined) {
      updates.push(`title = $${paramCount++}`);
      values.push(title);
    }
    
    if (status !== undefined) {
      if (!['active', 'closed', 'archived'].includes(status)) {
        return res.status(400).json({ error: 'Invalid status' });
      }
      updates.push(`status = $${paramCount++}`);
      values.push(status);
    }
    
    if (updates.length === 0) {
      return res.status(400).json({ error: 'No updates provided' });
    }
    
    values.push(req.facilitatorToken);
    
    await db.query(
      `UPDATE workshops SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP 
       WHERE facilitator_token = $${paramCount}`,
      values
    );
    
    res.json({ success: true, message: 'Workshop updated' });
    
  } catch (error) {
    console.error('Update workshop error:', error);
    res.status(500).json({ error: 'Failed to update workshop' });
  }
});

// Delete workshop
router.delete('/my', requireFacilitatorAuth, async (req, res) => {
  try {
    await db.query(
      'DELETE FROM workshops WHERE facilitator_token = $1',
      [req.facilitatorToken]
    );
    
    res.json({ success: true, message: 'Workshop deleted' });
    
  } catch (error) {
    console.error('Delete workshop error:', error);
    res.status(500).json({ error: 'Failed to delete workshop' });
  }
});

module.exports = router;
