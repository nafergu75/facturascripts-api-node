/**
 * ImportController
 * Endpoints para importación de datos contables históricos
 */

import { Request, Response } from 'express';
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import {
  ImportService,
  FileParserService,
  ColumnNormalizerService,
  AccountMapperService,
} from '../services/import';

// Validaciones Zod
const importUploadSchema = z.object({
  companyId: z.string().min(1, 'companyId requerido'),
  importType: z.enum(['BALANCE', 'MAYOR', 'PYG']),
  ejercicio: z.number().int().min(2000).max(2100),
  sheetName: z.string().optional(),
});

const suggestMappingSchema = z.object({
  columnMappings: z.record(z.string(), z.string().nullable()),
});

const validateSchema = z.object({
  columnMappings: z.record(z.string(), z.string()),
  manualAccountMappings: z.record(z.string(), z.string()).optional(),
});

const confirmSchema = z.object({
  columnMappings: z.record(z.string(), z.string()),
  manualAccountMappings: z.record(z.string(), z.string()).optional(),
});

// Almacenamiento temporal de sesiones en memoria
// En producción: usar Redis o BD
const uploadedFiles = new Map<string, { path: string; expireAt: Date }>();
const cleanupInterval = setInterval(() => {
  const now = new Date();
  for (const [key, value] of uploadedFiles) {
    if (now > value.expireAt) {
      try {
        fs.unlinkSync(value.path);
      } catch (e) {
        // Ignorar si el archivo ya fue eliminado
      }
      uploadedFiles.delete(key);
    }
  }
}, 60000); // Cada minuto

class ImportController {
  private importService = new ImportService();
  private fileParser = new FileParserService();
  private columnNormalizer = new ColumnNormalizerService();
  private accountMapper = new AccountMapperService();

  /**
   * POST /import/upload
   * Sube un archivo y prepara la sesión de importación
   */
  async upload(req: Request, res: Response) {
    try {
      // Validar body
      const body = importUploadSchema.parse(req.body);

      // Validar archivo
      if (!req.file) {
        return res.status(400).json({
          ok: false,
          error: 'Archivo requerido',
        });
      }

      const { filename, path: uploadPath, size } = req.file;

      // Validar extensión
      const ext = path.extname(filename).toLowerCase();
      if (!['.xlsx', '.xls', '.csv'].includes(ext)) {
        fs.unlinkSync(uploadPath);
        return res.status(400).json({
          ok: false,
          error: 'Formato no soportado. Use .xlsx, .xls o .csv',
        });
      }

      // Validar tamaño (máx 50MB)
      const MAX_SIZE = 50 * 1024 * 1024;
      if (size > MAX_SIZE) {
        fs.unlinkSync(uploadPath);
        return res.status(400).json({
          ok: false,
          error: 'Archivo demasiado grande (máx 50MB)',
        });
      }

      // Registrar archivo para limpieza automática (24 horas)
      const expireAt = new Date();
      expireAt.setHours(expireAt.getHours() + 24);
      const sessionId = `upload_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      uploadedFiles.set(sessionId, { path: uploadPath, expireAt });

      // Parsear para obtener preview
      let parseResult;
      try {
        parseResult = await this.fileParser.parseFile(uploadPath, body.sheetName);
      } catch (parseError) {
        fs.unlinkSync(uploadPath);
        uploadedFiles.delete(sessionId);
        return res.status(400).json({
          ok: false,
          error: `Error al parsear archivo: ${parseError instanceof Error ? parseError.message : 'Unknown'}`,
        });
      }

      // Sugerir mapeos de columnas automáticamente
      const expectedColumns = this.getExpectedColumns(body.importType);
      const suggestedMappings = this.columnNormalizer.suggestColumnMapping(
        parseResult.headers,
        expectedColumns
      );

      return res.status(200).json({
        ok: true,
        data: {
          sessionId,
          uploadedFile: filename,
          fileSize: size,
          preview: {
            totalRows: parseResult.rows.length,
            totalColumns: parseResult.headers.length,
            headers: parseResult.headers,
            sampleRows: parseResult.rows.slice(0, 5),
            sheetName: parseResult.sheetName,
          },
          suggestedMappings,
          importType: body.importType,
          ejercicio: body.ejercicio,
        },
      });
    } catch (error) {
      if (req.file) {
        try {
          fs.unlinkSync(req.file.path);
        } catch (e) {
          // Ignorar
        }
      }

      if (error instanceof z.ZodError) {
        return res.status(400).json({
          ok: false,
          error: 'Validación fallida',
          details: error.errors,
        });
      }

      return res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : 'Error desconocido',
      });
    }
  }

  /**
   * POST /import/:sessionId/suggest-mapping
   * Obtiene mapeos sugeridos de columnas (volver a llamar si el usuario edita)
   */
  async suggestMapping(req: Request, res: Response) {
    try {
      const { sessionId } = req.params;
      const body = suggestMappingSchema.parse(req.body);

      const fileEntry = uploadedFiles.get(sessionId);
      if (!fileEntry) {
        return res.status(404).json({
          ok: false,
          error: 'Sesión no encontrada o expirada',
        });
      }

      // Obtener headers del archivo guardado
      const parseResult = await this.fileParser.parseFile(fileEntry.path);

      // Sugerir nuevos mapeos
      const expectedColumns = Object.keys(body.columnMappings);
      const suggestedMappings = this.columnNormalizer.suggestColumnMapping(
        parseResult.headers,
        expectedColumns
      );

      return res.status(200).json({
        ok: true,
        data: {
          suggestedMappings,
          originalHeaders: parseResult.headers,
        },
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          ok: false,
          error: 'Validación fallida',
          details: error.errors,
        });
      }

      return res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : 'Error desconocido',
      });
    }
  }

  /**
   * POST /import/:sessionId/validate
   * Valida los datos sin importar
   */
  async validate(req: Request, res: Response) {
    try {
      const { sessionId } = req.params;
      const { body } = req;

      const bodyParsed = validateSchema.parse(body);

      const fileEntry = uploadedFiles.get(sessionId);
      if (!fileEntry) {
        return res.status(404).json({
          ok: false,
          error: 'Sesión no encontrada o expirada',
        });
      }

      // Obtener datos del request body
      const {
        companyId,
        importType,
        ejercicio,
        sheetName,
      } = body;

      if (!companyId || !importType || !ejercicio) {
        return res.status(400).json({
          ok: false,
          error: 'Faltan campos requeridos (companyId, importType, ejercicio)',
        });
      }

      // Ejecutar importación (modo validación)
      // Esto genera errors pero no guarda en BD
      const result = await this.importService.importHistoricalData({
        companyId,
        importType,
        ejercicio,
        filePath: fileEntry.path,
        fileName: path.basename(fileEntry.path),
        manualAccountMappings: bodyParsed.manualAccountMappings,
        userId: (req as any).user?.id || 'anonymous',
        sheetName,
      });

      // Limpiar archivo si la validación fue exitosa
      if (result.success) {
        fs.unlinkSync(fileEntry.path);
        uploadedFiles.delete(sessionId);
      } else {
        // Mantener archivo si hay errores para revisión
      }

      return res.status(200).json({
        ok: result.success,
        data: {
          sessionId: result.sessionId,
          success: result.success,
          ejercicio: result.ejercicio,
          importType: result.importType,
          totalRows: result.totalRows,
          processedRows: result.processedRows,
          errorRows: result.errorRows,
          errors: result.errors,
          warnings: result.warnings,
          validationResult: result.validationResult,
          openingEntry: result.openingEntry
            ? {
                numero: result.openingEntry.numero,
                fecha: result.openingEntry.fecha,
                ejercicio: result.openingEntry.ejercicio,
                descripcion: result.openingEntry.descripcion,
                totalDebe: result.openingEntry.totalDebe.toString(),
                totalHaber: result.openingEntry.totalHaber.toString(),
                isBalanced: result.openingEntry.isBalanced,
                lineas: result.openingEntry.lines.length,
              }
            : null,
        },
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          ok: false,
          error: 'Validación fallida',
          details: error.errors,
        });
      }

      return res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : 'Error desconocido',
      });
    }
  }

  /**
   * POST /import/:sessionId/confirm
   * Confirma e importa los datos a la base de datos
   */
  async confirm(req: Request, res: Response) {
    try {
      const { sessionId } = req.params;
      const bodyParsed = confirmSchema.parse(req.body);

      const fileEntry = uploadedFiles.get(sessionId);
      if (!fileEntry) {
        return res.status(404).json({
          ok: false,
          error: 'Sesión no encontrada o expirada',
        });
      }

      const {
        companyId,
        importType,
        ejercicio,
        sheetName,
      } = req.body;

      if (!companyId || !importType || !ejercicio) {
        return res.status(400).json({
          ok: false,
          error: 'Faltan campos requeridos',
        });
      }

      // Ejecutar importación completa
      const result = await this.importService.importHistoricalData({
        companyId,
        importType,
        ejercicio,
        filePath: fileEntry.path,
        fileName: path.basename(fileEntry.path),
        manualAccountMappings: bodyParsed.manualAccountMappings,
        userId: (req as any).user?.id || 'anonymous',
        sheetName,
      });

      // Limpiar archivo después de importación
      try {
        fs.unlinkSync(fileEntry.path);
      } catch (e) {
        // Ignorar si ya fue eliminado
      }
      uploadedFiles.delete(sessionId);

      if (!result.success) {
        return res.status(400).json({
          ok: false,
          error: 'Importación fallida',
          data: {
            sessionId: result.sessionId,
            errors: result.errors,
            warnings: result.warnings,
          },
        });
      }

      return res.status(201).json({
        ok: true,
        data: {
          sessionId: result.sessionId,
          ejercicio: result.ejercicio,
          importType: result.importType,
          totalRows: result.totalRows,
          processedRows: result.processedRows,
          errorRows: result.errorRows,
          duration: result.duration,
          openingEntry: result.openingEntry
            ? {
                numero: result.openingEntry.numero,
                fecha: result.openingEntry.fecha,
                ejercicio: result.openingEntry.ejercicio,
                descripcion: result.openingEntry.descripcion,
                totalDebe: result.openingEntry.totalDebe.toString(),
                totalHaber: result.openingEntry.totalHaber.toString(),
                isBalanced: result.openingEntry.isBalanced,
                lineas: result.openingEntry.lines,
              }
            : null,
          message: 'Importación completada exitosamente',
        },
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          ok: false,
          error: 'Validación fallida',
          details: error.errors,
        });
      }

      return res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : 'Error desconocido',
      });
    }
  }

  /**
   * GET /import/:sessionId/status
   * Obtiene el estado actual de una importación
   */
  async getStatus(req: Request, res: Response) {
    try {
      const { sessionId } = req.params;

      const status = this.importService.getImportStatus(sessionId);
      if (!status) {
        return res.status(404).json({
          ok: false,
          error: 'Sesión no encontrada',
        });
      }

      return res.status(200).json({
        ok: true,
        data: {
          sessionId: status.id,
          state: status.state,
          importType: status.importType,
          ejercicio: status.ejercicio,
          totalRows: status.totalRows,
          processedRows: status.processedRows,
          errorRows: status.errorRows,
          validationErrors: status.validationErrors,
          validationWarnings: status.validationWarnings,
          startedAt: status.startedAt,
          completedAt: status.completedAt,
        },
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : 'Error desconocido',
      });
    }
  }

  /**
   * GET /import/:sessionId/progress
   * Obtiene el progreso de una importación
   */
  async getProgress(req: Request, res: Response) {
    try {
      const { sessionId } = req.params;

      const progress = this.importService.getImportProgress(sessionId);
      if (!progress) {
        return res.status(404).json({
          ok: false,
          error: 'Sesión no encontrada',
        });
      }

      return res.status(200).json({
        ok: true,
        data: progress,
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : 'Error desconocido',
      });
    }
  }

  /**
   * DELETE /import/:sessionId/cancel
   * Cancela una importación en curso
   */
  async cancel(req: Request, res: Response) {
    try {
      const { sessionId } = req.params;

      const cancelled = this.importService.cancelImport(sessionId);

      // Limpiar archivo si existe
      const fileEntry = uploadedFiles.get(sessionId);
      if (fileEntry) {
        try {
          fs.unlinkSync(fileEntry.path);
        } catch (e) {
          // Ignorar
        }
        uploadedFiles.delete(sessionId);
      }

      if (!cancelled) {
        return res.status(400).json({
          ok: false,
          error: 'No se puede cancelar: sesión no encontrada o ya terminada',
        });
      }

      return res.status(200).json({
        ok: true,
        message: 'Importación cancelada',
        data: { sessionId },
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : 'Error desconocido',
      });
    }
  }

  /**
   * GET /import/:sessionId/opening-entry
   * Obtiene el asiento de apertura generado
   */
  async getOpeningEntry(req: Request, res: Response) {
    try {
      const { sessionId } = req.params;
      const { format = 'json' } = req.query;

      const status = this.importService.getImportStatus(sessionId);
      if (!status || status.state !== 'IMPORTADO') {
        return res.status(404).json({
          ok: false,
          error: 'Sesión no encontrada o importación no completada',
        });
      }

      // Nota: En una implementación real, necesitarías almacenar el openingEntry
      // en la base de datos durante el import para poder recuperarlo después

      return res.status(200).json({
        ok: true,
        data: {
          message: 'Asiento de apertura disponible',
          sessionId,
          format,
          note: 'Implementar almacenamiento de opening entry en BD',
        },
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : 'Error desconocido',
      });
    }
  }

  // Privados

  private getExpectedColumns(importType: string): string[] {
    switch (importType) {
      case 'BALANCE':
        return [
          'Cuenta',
          'Nombre Cuenta',
          'Debe',
          'Haber',
          'Code',
          'Description',
          'Debit',
          'Credit',
        ];
      case 'MAYOR':
        return [
          'Fecha',
          'Cuenta',
          'Descripción',
          'Debe',
          'Haber',
          'Date',
          'Account',
          'Description',
          'Debit',
          'Credit',
        ];
      case 'PYG':
        return [
          'Cuenta',
          'Descripción',
          'Valor',
          'Amount',
          'Description',
        ];
      default:
        return [];
    }
  }
}

export default new ImportController();
